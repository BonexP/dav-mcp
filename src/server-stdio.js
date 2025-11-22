#!/usr/bin/env node

/**
 * DAV-MCP Server STDIO Implementation
 * 
 * Complete STDIO transport layer for MCP protocol using StdioServerTransport.
 * Provides full compatibility with existing HTTP/SSE implementation while
 * enabling direct process communication for local MCP clients.
 */

import dotenv from 'dotenv';
import crypto from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { tsdavManager } from './tsdav-client.js';
import { tools } from './tools/index.js';
import { createToolErrorResponse, MCP_ERROR_CODES } from './error-handler.js';
import { logger, createRequestLogger } from './logger.js';
import { initializeToolCallLogger, getToolCallLogger } from './tool-call-logger.js';

// Load environment variables
dotenv.config();

/**
 * Initialize tsdav clients with configuration
 * Supports both Basic Auth and OAuth2 authentication
 */
async function initializeTsdav() {
  try {
    const authMethod = process.env.AUTH_METHOD || 'Basic';

    if (authMethod === 'OAuth' || authMethod === 'Oauth') {
      // OAuth2 Configuration (e.g., Google Calendar)
      logger.info('Initializing with OAuth2 authentication');

      if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REFRESH_TOKEN) {
        throw new Error('OAuth2 requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN');
      }

      await tsdavManager.initialize({
        serverUrl: process.env.GOOGLE_SERVER_URL || 'https://apidata.googleusercontent.com/caldav/v2/',
        authMethod: 'OAuth',
        username: process.env.GOOGLE_USER,
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
        tokenUrl: process.env.GOOGLE_TOKEN_URL || 'https://accounts.google.com/o/oauth2/token',
      });

      logger.info('OAuth2 clients initialized successfully');
    } else {
      // Basic Auth Configuration (standard CalDAV servers)
      logger.info('Initializing with Basic authentication');

      if (!process.env.CALDAV_SERVER_URL || !process.env.CALDAV_USERNAME || !process.env.CALDAV_PASSWORD) {
        throw new Error('Basic Auth requires CALDAV_SERVER_URL, CALDAV_USERNAME, and CALDAV_PASSWORD');
      }

      await tsdavManager.initialize({
        serverUrl: process.env.CALDAV_SERVER_URL,
        authMethod: 'Basic',
        username: process.env.CALDAV_USERNAME,
        password: process.env.CALDAV_PASSWORD,
      });

      logger.info('Basic Auth clients initialized successfully');
    }

    logger.info('tsdav clients initialized successfully');
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to initialize tsdav clients');
    throw error;
  }
}

/**
 * Create MCP Server instance with STDIO transport
 */
function createMCPServer() {
  const server = new Server(
    {
      name: process.env.MCP_SERVER_NAME || 'dav-mcp-stdio',
      version: process.env.MCP_SERVER_VERSION || '2.7.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register tools/list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const requestId = crypto.randomUUID();
    const requestLogger = createRequestLogger(requestId);

    requestLogger.debug('tools/list request received');
    const toolList = tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    requestLogger.debug({ count: toolList.length }, 'Returning tools list');
    return { tools: toolList };
  });

  // Register tools/call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const requestId = crypto.randomUUID();
    const requestLogger = createRequestLogger(requestId);
    const toolCallLogger = getToolCallLogger();

    const toolName = request.params.name;
    const args = request.params.arguments || {};

    requestLogger.info({ tool: toolName, args }, 'tools/call request received');

    const tool = tools.find(t => t.name === toolName);
    if (!tool) {
      requestLogger.error({ tool: toolName }, 'Tool not found');
      const error = new Error(`Unknown tool: ${toolName}`);
      error.code = MCP_ERROR_CODES.METHOD_NOT_FOUND;
      throw error;
    }

    // Log tool call start
    const startTime = Date.now();
    toolCallLogger.logToolCallStart(toolName, args, {
      requestId,
      transport: 'stdio'
    });

    try {
      requestLogger.debug({ tool: toolName }, 'Executing tool');
      
      // Check if tsdav is initialized before executing tools that need it
      const needsTsdav = toolName !== 'list_calendars' && toolName !== 'list_addressbooks' && toolName !== 'list_todos';
      
      if (needsTsdav) {
        try {
          // Test if tsdav is properly initialized
          tsdavManager.getCalDavClient();
        } catch (tsdavError) {
          requestLogger.warn('CalDAV client not initialized, tool may fail');
          console.log(`[DAV-MCP] Warning: CalDAV not initialized for tool '${toolName}'. This may fail.`);
        }
      }
      
      const result = await tool.handler(args);
      const duration = Date.now() - startTime;

      requestLogger.info({ tool: toolName }, 'Tool executed successfully');

      // Log tool call success
      toolCallLogger.logToolCallSuccess(toolName, args, result, {
        requestId,
        transport: 'stdio',
        duration
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      requestLogger.error({ tool: toolName, error: error.message, stack: error.stack }, 'Tool execution error');

      // Provide helpful error message for common issues
      let enhancedError = error;
      if (error.message?.includes('caldav') || error.message?.includes('CalDAV')) {
        enhancedError = new Error('CalDAV connection not configured. Please set CALDAV_SERVER_URL, CALDAV_USERNAME, CALDAV_PASSWORD environment variables.');
        enhancedError.code = MCP_ERROR_CODES.CALDAV_ERROR;
      } else if (error.message?.includes('Unauthorized') || error.message?.includes('401')) {
        enhancedError = new Error('Authentication failed. Please check your CalDAV credentials.');
        enhancedError.code = MCP_ERROR_CODES.AUTH_ERROR;
      }

      // Log tool call error
      toolCallLogger.logToolCallError(toolName, args, enhancedError, {
        requestId,
        transport: 'stdio',
        duration
      });

      return createToolErrorResponse(enhancedError, process.env.NODE_ENV === 'development');
    }
  });

  logger.info('MCP Server created for STDIO transport');
  return server;
}

/**
 * Graceful shutdown handler
 */
async function gracefulShutdown(signal) {
  logger.info({ signal }, 'Received shutdown signal, starting graceful shutdown...');

  try {
    // Close transport if exists
    if (global.transport) {
      await global.transport.close();
      logger.info('STDIO transport closed');
    }

    // Clear cleanup interval
    if (global.cleanupInterval) {
      clearInterval(global.cleanupInterval);
    }

    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error({ error: error.message }, 'Error during graceful shutdown');
    process.exit(1);
  }
}

/**
 * Health check for STDIO mode
 */
function performHealthCheck() {
  const health = {
    status: 'healthy',
    server: process.env.MCP_SERVER_NAME || 'dav-mcp-stdio',
    version: process.env.MCP_SERVER_VERSION || '2.7.0',
    timestamp: new Date().toISOString(),
    transport: 'stdio',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    tools: {
      total: tools.length,
      categories: {
        calendar: tools.filter(t => t.name.startsWith('calendar_') || t.name.startsWith('list_calendars') || t.name.startsWith('list_events') || t.name.startsWith('create_event') || t.name.startsWith('update_event') || t.name.startsWith('delete_event') || t.name.startsWith('calendar_query') || t.name.startsWith('make_calendar') || t.name.startsWith('update_calendar') || t.name.startsWith('delete_calendar') || t.name.startsWith('calendar_multi_get')).length,
        contacts: tools.filter(t => t.name.startsWith('addressbook_') || t.name.startsWith('list_addressbooks') || t.name.startsWith('list_contacts') || t.name.startsWith('create_contact') || t.name.startsWith('update_contact') || t.name.startsWith('delete_contact') || t.name.startsWith('addressbook_query') || t.name.startsWith('addressbook_multi_get')).length,
        todos: tools.filter(t => t.name.startsWith('todo_') || t.name.startsWith('list_todos') || t.name.startsWith('create_todo') || t.name.startsWith('update_todo') || t.name.startsWith('delete_todo') || t.name.startsWith('todo_query') || t.name.startsWith('todo_multi_get')).length
      }
    }
  };

  logger.debug({ health }, 'Health check performed');
  return health;
}

/**
 * Main server startup function
 */
async function start() {
  try {
    console.log('[DAV-MCP] Starting STDIO server...');
    logger.info('Starting DAV-MCP Server (STDIO mode)...');

    // Check if we have environment variables, but be more lenient
    const hasBasicAuth = process.env.CALDAV_SERVER_URL && process.env.CALDAV_USERNAME && process.env.CALDAV_PASSWORD;
    const hasOAuth2 = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN;
    const authMethod = process.env.AUTH_METHOD || 'Basic';

    if (!hasBasicAuth && !hasOAuth2 && authMethod !== 'Dummy') {
      console.log('[DAV-MCP] Warning: No CalDAV credentials found. Server will start but tools will fail until configured.');
      console.log('[DAV-MCP] Configure: CALDAV_SERVER_URL, CALDAV_USERNAME, CALDAV_PASSWORD for Basic Auth');
      console.log('[DAV-MCP] Or configure GOOGLE_* variables for OAuth2');
      console.log('[DAV-MCP] Or set AUTH_METHOD=Dummy for testing');
    }

    try {
      // Initialize tsdav clients (may fail if no credentials)
      if (hasBasicAuth || hasOAuth2) {
        await initializeTsdav();
      } else {
        console.log('[DAV-MCP] Skipping tsdav initialization - no credentials provided');
      }
    } catch (tsdavError) {
      console.log('[DAV-MCP] CalDAV initialization failed, but continuing with limited functionality:');
      console.log(`[DAV-MCP] Error: ${tsdavError.message}`);
      // Don't throw - allow server to start for testing
    }

    // Initialize tool call logger
    const toolCallLogger = initializeToolCallLogger();
    logger.info({
      enabled: toolCallLogger.enabled,
      mode: toolCallLogger.outputMode,
      logFile: toolCallLogger.logFile
    }, 'Tool call logger initialized');

    // Create MCP server
    const mcpServer = createMCPServer();

    // Create STDIO transport
    const transport = new StdioServerTransport();
    global.transport = transport; // Store globally for shutdown handler

    // Set up transport event handlers
    transport.onerror = (error) => {
      console.error('[DAV-MCP] Transport error:', error.message);
      logger.error({ error: error.message }, 'STDIO transport error');
    };

    transport.onclose = () => {
      console.log('[DAV-MCP] Transport closed');
      logger.info('STDIO transport closed');
    };

    // Connect server to transport
    await mcpServer.connect(transport);

    // Register shutdown handlers
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
      console.error('[DAV-MCP] Uncaught exception:', error.message);
      logger.error({ error: error.message, stack: error.stack }, 'Uncaught exception');
      gracefulShutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('[DAV-MCP] Unhandled promise rejection:', reason);
      logger.error({ reason, promise }, 'Unhandled promise rejection');
      gracefulShutdown('unhandledRejection');
    });

    // Log startup success
    const health = performHealthCheck();
    console.log('[DAV-MCP] ✅ Server started successfully!');
    console.log(`[DAV-MCP] Server: ${health.server} v${health.version}`);
    console.log(`[DAV-MCP] Transport: ${health.transport}`);
    console.log(`[DAV-MCP] Tools: ${health.tools.total} (Calendar: ${health.tools.categories.calendar}, Contacts: ${health.tools.categories.contacts}, Todos: ${health.tools.categories.todos})`);
    
    logger.info({
      server: health.server,
      version: health.version,
      transport: health.transport,
      tools: health.tools.total,
      categories: health.tools.categories
    }, 'DAV-MCP Server ready (STDIO mode)');

    // Log available tools (only in debug mode)
    if (process.env.LOG_LEVEL === 'debug') {
      tools.forEach(tool => {
        logger.debug({ name: tool.name, description: tool.description }, 'Tool registered');
      });
    }

  } catch (error) {
    console.error('[DAV-MCP] ❌ Failed to start server:');
    console.error(`[DAV-MCP] Error: ${error.message}`);
    if (process.env.NODE_ENV === 'development') {
      console.error(`[DAV-MCP] Stack: ${error.stack}`);
    }
    logger.error({ error: error.message, stack: error.stack }, 'Failed to start server');
    process.exit(1);
  }
}

// Start the server
start().catch(error => {
  logger.error({ error: error.message, stack: error.stack }, 'Server startup failed');
  process.exit(1);
});