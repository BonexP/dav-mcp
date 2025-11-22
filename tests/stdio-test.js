#!/usr/bin/env node

/**
 * DAV-MCP STDIO Server Test Suite
 * 
 * Tests the STDIO transport implementation and verifies compatibility
 * with MCP protocol standards and existing functionality.
 */

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import dotenv from 'dotenv';

// Load test environment
dotenv.config({ path: '.env.test' });

/**
 * Test result collector
 */
class TestResult {
  constructor() {
    this.passed = 0;
    this.failed = 0;
    this.tests = [];
  }

  pass(name, details = {}) {
    this.passed++;
    this.tests.push({ name, status: 'PASS', ...details });
    console.log(`✅ ${name}`);
  }

  fail(name, error, details = {}) {
    this.failed++;
    this.tests.push({ name, status: 'FAIL', error: error.message, ...details });
    console.log(`❌ ${name}: ${error.message}`);
  }

  summary() {
    const total = this.passed + this.failed;
    console.log(`\n📊 Test Results: ${this.passed}/${total} passed, ${this.failed} failed`);
    
    if (this.failed > 0) {
      console.log('\n❌ Failed Tests:');
      this.tests.filter(t => t.status === 'FAIL').forEach(t => {
        console.log(`  - ${t.name}: ${t.error}`);
      });
    }
    
    return this.failed === 0;
  }
}

/**
 * Test STDIO server startup
 */
async function testServerStartup(result) {
  return new Promise((resolve) => {
    console.log('\n🚀 Testing Server Startup...');
    
    const serverProcess = spawn('node', ['src/server-stdio.js'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test' }
    });

    let output = '';
    let errorOutput = '';
    
    serverProcess.stdout.on('data', (data) => {
      output += data.toString();
    });

    serverProcess.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    // Wait 5 seconds for startup
    const timeout = setTimeout(() => {
      serverProcess.kill();
      
      if (output.includes('DAV-MCP Server ready') || output.includes('DAV-MCP Server running')) {
        result.pass('Server Startup', { output: output.substring(0, 200) });
      } else {
        result.fail('Server Startup', new Error('Server did not start successfully'), { 
          output, 
          errorOutput 
        });
      }
      
      resolve();
    }, 5000);

    serverProcess.on('error', (error) => {
      clearTimeout(timeout);
      result.fail('Server Process Error', error);
      resolve();
    });

    serverProcess.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        result.pass('Server Clean Exit', { code });
      } else {
        result.fail('Server Unexpected Exit', new Error(`Process exited with code ${code}`), { code, errorOutput });
      }
      resolve();
    });
  });
}

/**
 * Test MCP tools list via STDIO
 */
async function testToolsList(result) {
  return new Promise((resolve) => {
    console.log('\n🔧 Testing Tools List...');
    
    const serverProcess = spawn('node', ['src/server-stdio.js'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test' }
    });

    const toolsListRequest = {
      jsonrpc: '2.0',
      id: 'test-tools-1',
      method: 'tools/list',
      params: {}
    };

    let output = '';
    let responseReceived = false;
    
    serverProcess.stdout.on('data', (data) => {
      output += data.toString();
      
      // Check for tools/list response
      if (output.includes('"result"') && output.includes('"tools"')) {
        responseReceived = true;
        
        try {
          const lines = output.trim().split('\n');
          const lastLine = lines[lines.length - 1];
          const response = JSON.parse(lastLine);
          
          if (response.result && response.result.tools && Array.isArray(response.result.tools)) {
            const toolCount = response.result.tools.length;
            if (toolCount > 20) { // Expecting 26 tools
              result.pass('Tools List Response', { 
                toolCount,
                sampleTools: response.result.tools.slice(0, 3).map(t => t.name)
              });
            } else {
              result.fail('Tools List Response', new Error(`Expected 26+ tools, got ${toolCount}`));
            }
          } else {
            result.fail('Tools List Response Format', new Error('Invalid response structure'));
          }
        } catch (parseError) {
          result.fail('Tools List JSON Parse', parseError);
        }
        
        serverProcess.kill();
        resolve();
      }
    });

    // Send tools list request
    setTimeout(() => {
      if (!responseReceived) {
        serverProcess.stdin.write(JSON.stringify(toolsListRequest) + '\n');
      }
    }, 1000);

    // Timeout after 10 seconds
    setTimeout(() => {
      if (!responseReceived) {
        serverProcess.kill();
        result.fail('Tools List Timeout', new Error('No response received within 10 seconds'));
        resolve();
      }
    }, 10000);

    serverProcess.stderr.on('data', (data) => {
      console.error('Server stderr:', data.toString());
    });
  });
}

/**
 * Test basic tool execution
 */
async function testToolExecution(result) {
  return new Promise((resolve) => {
    console.log('\n⚡ Testing Tool Execution...');
    
    const serverProcess = spawn('node', ['src/server-stdio.js'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test' }
    });

    // Test list_calendars tool (should not require network)
    const toolCallRequest = {
      jsonrpc: '2.0',
      id: 'test-tool-1',
      method: 'tools/call',
      params: {
        name: 'list_calendars',
        arguments: {}
      }
    };

    let output = '';
    let responseReceived = false;
    
    serverProcess.stdout.on('data', (data) => {
      output += data.toString();
      
      // Check for tools/call response
      if (output.includes('"result"') || output.includes('"error"')) {
        responseReceived = true;
        
        try {
          const lines = output.trim().split('\n');
          const lastLine = lines[lines.length - 1];
          const response = JSON.parse(lastLine);
          
          if (response.result) {
            result.pass('Tool Execution', { 
              responseType: 'result',
              hasContent: !!(response.result.content)
            });
          } else if (response.error) {
            // Expected to fail without proper CalDAV config
            if (response.error.code === -32003 || response.error.message?.includes('auth')) {
              result.pass('Tool Execution (Auth Expected)', { 
                errorCode: response.error.code,
                errorMessage: response.error.message
              });
            } else {
              result.fail('Tool Execution Unexpected Error', new Error(response.error.message));
            }
          }
        } catch (parseError) {
          result.fail('Tool Execution JSON Parse', parseError);
        }
        
        serverProcess.kill();
        resolve();
      }
    });

    // Send tool call request
    setTimeout(() => {
      if (!responseReceived) {
        serverProcess.stdin.write(JSON.stringify(toolCallRequest) + '\n');
      }
    }, 2000);

    // Timeout after 10 seconds
    setTimeout(() => {
      if (!responseReceived) {
        serverProcess.kill();
        result.fail('Tool Execution Timeout', new Error('No response received within 10 seconds'));
        resolve();
      }
    }, 10000);

    serverProcess.stderr.on('data', (data) => {
      console.error('Server stderr:', data.toString());
    });
  });
}

/**
 * Test environment configuration
 */
async function testEnvironmentConfig(result) {
  console.log('\n⚙️  Testing Environment Configuration...');
  
  try {
    // Test required variables
    const requiredVars = ['CALDAV_SERVER_URL', 'CALDAV_USERNAME', 'CALDAV_PASSWORD'];
    const missingVars = requiredVars.filter(varName => !process.env[varName]);
    
    if (missingVars.length === 0) {
      result.pass('Required Environment Variables', { 
        variables: requiredVars 
      });
    } else {
      result.fail('Required Environment Variables', new Error(`Missing: ${missingVars.join(', ')}`));
    }

    // Test optional variables
    const optionalVars = ['MCP_SERVER_NAME', 'MCP_SERVER_VERSION', 'LOG_LEVEL'];
    const presentOptionalVars = optionalVars.filter(varName => process.env[varName]);
    
    if (presentOptionalVars.length > 0) {
      result.pass('Optional Environment Variables', {
        present: presentOptionalVars,
        count: presentOptionalVars.length
      });
    } else {
      result.pass('Optional Environment Variables (None Set)', {
        note: 'Using defaults is fine'
      });
    }

  } catch (error) {
    result.fail('Environment Configuration', error);
  }
}

/**
 * Test file structure
 */
async function testFileStructure(result) {
  console.log('\n📁 Testing File Structure...');
  
  try {
    const requiredFiles = [
      'src/server-stdio.js',
      'src/index.js',
      'src/tsdav-client.js',
      'src/tools/index.js',
      'src/logger.js',
      'src/error-handler.js'
    ];

    const fs = await import('fs');
    const existingFiles = requiredFiles.filter(file => fs.existsSync(file));
    
    if (existingFiles.length === requiredFiles.length) {
      result.pass('Required Files Present', { 
        files: existingFiles 
      });
    } else {
      const missing = requiredFiles.filter(file => !fs.existsSync(file));
      result.fail('Required Files Missing', new Error(`Missing: ${missing.join(', ')}`));
    }

    // Test server-stdio.js specifically
    if (fs.existsSync('src/server-stdio.js')) {
      const content = fs.readFileSync('src/server-stdio.js', 'utf8');
      
      const requiredImports = [
        'StdioServerTransport',
        '@modelcontextprotocol/sdk',
        'tsdavManager',
        'tools',
        'logger'
      ];
      
      const missingImports = requiredImports.filter(imp => !content.includes(imp));
      
      if (missingImports.length === 0) {
        result.pass('Server-STDIO.js Imports', { 
          imports: requiredImports 
        });
      } else {
        result.fail('Server-STDIO.js Imports', new Error(`Missing imports: ${missingImports.join(', ')}`));
      }

      // Check for main function
      if (content.includes('start()') || content.includes('async function start')) {
        result.pass('Server-STDIO.js Main Function', {});
      } else {
        result.fail('Server-STDIO.js Main Function', new Error('No start function found'));
      }
    }

  } catch (error) {
    result.fail('File Structure', error);
  }
}

/**
 * Run all tests
 */
async function runAllTests() {
  console.log('🧪 DAV-MCP STDIO Server Test Suite');
  console.log('===================================');

  const result = new TestResult();

  // Ensure test environment file exists
  const fs = await import('fs');
  if (!fs.existsSync('.env.test')) {
    console.log('Creating .env.test file...');
    fs.writeFileSync('.env.test', `# Test Environment Variables
CALDAV_SERVER_URL=https://test.dav.example.com
CALDAV_USERNAME=test_user
CALDAV_PASSWORD=test_password
MCP_SERVER_NAME=dav-mcp-test
MCP_SERVER_VERSION=2.7.0
LOG_LEVEL=debug
NODE_ENV=test
`);
  }

  try {
    await testFileStructure(result);
    await testEnvironmentConfig(result);
    await testServerStartup(result);
    await testToolsList(result);
    await testToolExecution(result);
  } catch (error) {
    result.fail('Test Suite Error', error);
  }

  const success = result.summary();
  
  // Cleanup
  if (fs.existsSync('.env.test')) {
    console.log('\n🧹 Cleaning up test environment...');
    // Keep the test file for future runs
  }

  process.exit(success ? 0 : 1);
}

// Run tests if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests().catch(error => {
    console.error('Test suite failed:', error);
    process.exit(1);
  });
}

export { runAllTests, testServerStartup, testToolsList, testToolExecution, testEnvironmentConfig, testFileStructure };