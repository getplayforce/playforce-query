const path = require('path');
const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
const http = require('http');
const url = require('url');

let mainWindow;
let resultWindows = []; // Track all result popup windows
let oauthCallbackServer;
let actualRedirectUri = null; // Will be set when server starts
const PORT_RANGE_START = 8888;
const PORT_RANGE_END = 8892; // Try 5 ports

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        webPreferences: {
            contextIsolation: false,
            nodeIntegration: true,
            enableRemoteModule: false,
            sandbox: false
        }
    });

    // Open DevTools automatically
    //mainWindow.webContents.openDevTools();


    // Remove default menu (File, Edit, Window, Help)
    Menu.setApplicationMenu(null);

    mainWindow.loadFile('index.html');
    
    // Close all result windows when main window is closed
    mainWindow.on('closed', () => {
        resultWindows.forEach(win => {
            if (win && !win.isDestroyed()) {
                win.close();
            }
        });
        resultWindows = [];
        mainWindow = null;
    });
}

// Setup OAuth callback server with automatic port fallback
function startOAuthCallbackServer() {
    return new Promise((resolve, reject) => {
        if (oauthCallbackServer && actualRedirectUri) {
            resolve(actualRedirectUri);
            return;
        }

        const requestHandler = (req, res) => {
            const parsedUrl = url.parse(req.url, true);
            
            if (parsedUrl.pathname === '/oauth/callback') {
                const { code, error, error_description } = parsedUrl.query;
                
                if (error) {
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(`
                        <html>
                            <body style="font-family: sans-serif; padding: 40px; text-align: center;">
                                <h2 style="color: #d73a49;">Authentication Failed</h2>
                                <p>${error}: ${error_description || 'Unknown error'}</p>
                                <p>You can close this window.</p>
                            </body>
                        </html>
                    `);
                    mainWindow.webContents.send('oauth-error', { error, error_description });
                } else if (code) {
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(`
                        <html>
                            <body style="font-family: sans-serif; padding: 40px; text-align: center;">
                                <h2 style="color: #28a745;">Authentication Successful!</h2>
                                <p>You can close this window and return to the application.</p>
                            </body>
                        </html>
                    `);
                    mainWindow.webContents.send('oauth-callback', code);
                } else {
                    res.writeHead(400, { 'Content-Type': 'text/plain' });
                    res.end('Invalid callback');
                }
            } else {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not found');
            }
        };

        oauthCallbackServer = http.createServer(requestHandler);

        // Try ports in range
        let currentPort = PORT_RANGE_START;
        
        const tryNextPort = () => {
            if (currentPort > PORT_RANGE_END) {
                const errorMsg = `Unable to start OAuth callback server. Ports ${PORT_RANGE_START}-${PORT_RANGE_END} are all in use.\n\nPlease close other applications and try again.`;
                console.error(errorMsg);
                reject(new Error(errorMsg));
                return;
            }

            oauthCallbackServer.listen(currentPort, '127.0.0.1', () => {
                actualRedirectUri = `http://localhost:${currentPort}/oauth/callback`;
                console.log(`OAuth callback server listening on port ${currentPort}`);
                if (currentPort !== PORT_RANGE_START) {
                    console.log(`Note: Using port ${currentPort} instead of ${PORT_RANGE_START}`);
                }
                resolve(actualRedirectUri);
            });

            oauthCallbackServer.once('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    console.log(`Port ${currentPort} is in use, trying next port...`);
                    currentPort++;
                    oauthCallbackServer.close();
                    oauthCallbackServer = http.createServer(requestHandler);
                    tryNextPort();
                } else if (err.code === 'EACCES') {
                    console.log(`Port ${currentPort} access denied (firewall/antivirus?), trying next port...`);
                    currentPort++;
                    oauthCallbackServer.close();
                    oauthCallbackServer = http.createServer(requestHandler);
                    tryNextPort();
                } else {
                    console.error('OAuth callback server error:', err);
                    reject(err);
                }
            });
        };

        tryNextPort();
    });
}

// Load salesforce module once at startup
const salesforce = require('./salesforce.js');

// Handle config operations
ipcMain.handle('set-config-file', async (event, configName) => {
    try {
        return salesforce.setConfigFile(configName);
    } catch (error) {
        console.error('Error setting config file:', error);
        return false;
    }
});

ipcMain.handle('list-configs', async (event) => {
    try {
        return salesforce.listConfigs();
    } catch (error) {
        console.error('Error listing configs:', error);
        return [];
    }
});

ipcMain.handle('get-current-config', async (event) => {
    try {
        return salesforce.getCurrentConfig();
    } catch (error) {
        console.error('Error getting current config:', error);
        return null;
    }
});

ipcMain.handle('requires-oauth', async (event) => {
    try {
        return salesforce.requiresOAuth();
    } catch (error) {
        console.error('Error checking OAuth requirement:', error);
        return false;
    }
});

ipcMain.handle('try-authenticate', async (event) => {
    try {
        return await salesforce.tryAuthenticate();
    } catch (error) {
        console.error('Error trying authentication:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('has-valid-token', async (event) => {
    try {
        return salesforce.hasValidToken();
    } catch (error) {
        console.error('Error checking token:', error);
        return false;
    }
});

// Handle OAuth flow initiation
ipcMain.handle('start-oauth-flow', async (event) => {
    try {
        // Debug: Check current config state
        const configState = salesforce.getCurrentConfig();
        console.log('OAuth flow - Current config state:', configState);
        
        if (!configState.currentConfigFile) {
            throw new Error('No configuration file selected. Please select an environment first.');
        }
        
        const redirectUri = await startOAuthCallbackServer();
        const authUrl = salesforce.getAuthorizationUrl(redirectUri);
        
        // Open in external browser
        await shell.openExternal(authUrl);
        
        return { success: true, redirectUri };
    } catch (error) {
        console.error('Error starting OAuth flow:', error);
        return { success: false, error: error.message };
    }
});

// Handle authorization code exchange
ipcMain.handle('exchange-auth-code', async (event, authCode, redirectUri) => {
    try {
        const tokenData = await salesforce.authenticateWithAuthCode(authCode, redirectUri);
        return { success: true, tokenData };
    } catch (error) {
        console.error('Error exchanging auth code:', error);
        return { success: false, error: error.message };
    }
});

// Track abort controllers for each query
const abortControllers = new Map();
const lastProgressData = new Map(); // Store last progress update for each query
const restAbortControllers = new Map();
const lastRestProgressData = new Map();

// Handle SOQL execution with pagination progress
ipcMain.handle('execute-soql', async (event, query, queryId) => {
    try {
        // Create abort controller for this query
        const abortController = new AbortController();
        if (queryId) {
            abortControllers.set(queryId, abortController);
        }
        
        const result = await salesforce.executeSOQL(query, (progress) => {
            // Store the last progress update
            if (queryId) {
                lastProgressData.set(queryId, progress);
            }
            // Send progress updates to the renderer
            event.sender.send('soql-progress', progress);
        }, abortController.signal);
        
        // Clean up abort controller and progress data
        if (queryId) {
            abortControllers.delete(queryId);
            lastProgressData.delete(queryId);
        }
        
        return result;
    } catch (error) {
        // Clean up abort controller
        if (queryId) {
            abortControllers.delete(queryId);
        }
        
        // Don't throw abort errors - these are expected when user stops a query
        // Return partial data if available
        if (error.name === 'AbortError') {
            const partialData = lastProgressData.get(queryId) || {};
            lastProgressData.delete(queryId);
            return { 
                aborted: true,
                totalSize: partialData.totalSize || 0,
                fetchedCount: partialData.fetchedCount || 0
            };
        }
        
        // Log and throw other errors
        console.error('Error executing SOQL:', error);
        throw error;
    }
});

// Handle query abort
ipcMain.handle('abort-query', async (event, queryId) => {
    try {
        const controller = abortControllers.get(queryId);
        if (controller) {
            console.log('Aborting query:', queryId);
            controller.abort();
            abortControllers.delete(queryId);
            return { success: true };
        }

        const restController = restAbortControllers.get(queryId);
        if (restController) {
            console.log('Aborting REST query:', queryId);
            restController.abort();
            restAbortControllers.delete(queryId);
            return { success: true };
        }

        return { success: false, error: 'Query not found' };
    } catch (error) {
        console.error('Error aborting query:', error);
        return { success: false, error: error.message };
    }
});

// Handle REST execution
ipcMain.handle('execute-rest', async (event, path, method = 'GET', body = null, headers = null, requestId = null, apiMode = null) => {
    try {
        const abortController = new AbortController();
        if (requestId) {
            restAbortControllers.set(requestId, abortController);
        }

        const result = await salesforce.executeREST(path, method, body, headers, (progress) => {
            if (requestId) {
                lastRestProgressData.set(requestId, progress);
            }
            event.sender.send('rest-progress', {
                requestId,
                ...progress
            });
        }, abortController.signal, apiMode);

        if (requestId) {
            restAbortControllers.delete(requestId);
            lastRestProgressData.delete(requestId);
        }

        return result;
    } catch (error) {
        if (requestId) {
            restAbortControllers.delete(requestId);
        }

        if (error.name === 'AbortError' || error.message?.includes('aborted') || error.message?.includes('AbortError')) {
            const partialData = requestId ? lastRestProgressData.get(requestId) : null;
            if (requestId) {
                lastRestProgressData.delete(requestId);
            }

            if (partialData?.result) {
                return {
                    ...partialData.result,
                    aborted: true,
                    _abortedPending: Array.isArray(partialData.pending) ? partialData.pending : []
                };
            }

            return {
                aborted: true,
                _abortedPending: []
            };
        }

        console.error('Error executing REST:', error);
        throw error;
    }
});

// Handle describe global request
ipcMain.handle('describe-global', async (event) => {
    try {
        return await salesforce.describeGlobal();
    } catch (error) {
        console.error('Error describing global:', error);
        throw error;
    }
});

// Handle describe object request
ipcMain.handle('describe-object', async (event, objectName) => {
    try {
        return await salesforce.describeObject(objectName);
    } catch (error) {
        console.error('Error describing object:', error);
        throw error;
    }
});

// Handle fetch tooling objects request
ipcMain.handle('fetch-tooling-objects', async (event) => {
    try {
        return await salesforce.fetchToolingObjects();
    } catch (error) {
        console.error('Error fetching tooling objects:', error);
        throw error;
    }
});

// Handle fetch ID prefixes request
ipcMain.handle('fetch-id-prefixes', async (event) => {
    try {
        return await salesforce.fetchIdPrefixes();
    } catch (error) {
        console.error('Error fetching ID prefixes:', error);
        throw error;
    }
});

// Handle get object type from ID request
ipcMain.handle('get-object-type-from-id', async (event, recordId) => {
    try {
        return await salesforce.getObjectTypeFromId(recordId);
    } catch (error) {
        console.error('Error getting object type from ID:', error);
        throw error;
    }
});

// Handle license info request
ipcMain.handle('get-license-info', async (event) => {
    try {
        return salesforce.getLicenseInfo();
    } catch (error) {
        console.error('Error getting license info:', error);
        return { licensed: false, message: 'Error checking license' };
    }
});

ipcMain.handle('fetch-active-theme', async (event) => {
    try {
        return await salesforce.fetchActiveTheme();
    } catch (error) {
        console.error('Error fetching active theme:', error);
        return null;
    }
});

// Open external URL in system browser
ipcMain.handle('open-external', async (event, url) => {
    try {
        await shell.openExternal(url);
    } catch (error) {
        console.error('Error opening external URL:', error);
        throw error;
    }
});

// Track window positions for cascading
let lastWindowPosition = { x: 100, y: 100 };
const WINDOW_OFFSET = 30;

// Open a new window with REST API result
ipcMain.handle('open-result-window', async (event, data) => {
    try {
        // Get main window bounds to position relative to it
        const mainBounds = mainWindow.getBounds();
        
        // Calculate cascading position relative to main window
        const x = mainBounds.x + lastWindowPosition.x;
        const y = mainBounds.y + lastWindowPosition.y;
        
        // Update position for next window (cascade down-right)
        lastWindowPosition.x += WINDOW_OFFSET;
        lastWindowPosition.y += WINDOW_OFFSET;
        
        // Reset if we've cascaded too far
        if (lastWindowPosition.x > 400 || lastWindowPosition.y > 400) {
            lastWindowPosition = { x: 100, y: 100 };
        }
        
        const resultWindow = new BrowserWindow({
            width: 800,
            height: 600,
            x: x,
            y: y,
            frame: false,
            parent: mainWindow,
            webPreferences: {
                contextIsolation: false,
                nodeIntegration: true,
                enableRemoteModule: false,
                sandbox: false
            }
        });
        
        // Remove menu from result window
        resultWindow.setMenu(null);
        
        // Track result window
        resultWindows.push(resultWindow);
        
        // Store the data temporarily with the window ID
        const windowId = resultWindow.id;
        if (!global.resultWindowData) {
            global.resultWindowData = {};
        }
        const normalizedPayload = (data && typeof data === 'object' && (Object.prototype.hasOwnProperty.call(data, 'data') || Object.prototype.hasOwnProperty.call(data, 'request') || Object.prototype.hasOwnProperty.call(data, 'convertUtcToLocal')))
            ? data
            : { data };

        // Store both preloaded data and request mode payloads
        global.resultWindowData[windowId] = {
            data: Object.prototype.hasOwnProperty.call(normalizedPayload, 'data') ? normalizedPayload.data : null,
            request: normalizedPayload.request || null,
            convertUtcToLocal: normalizedPayload.convertUtcToLocal || false
        };
        
        // Clean up when window is closed
        resultWindow.on('closed', () => {
            if (global.resultWindowData) {
                delete global.resultWindowData[windowId];
            }
            // Remove from tracking array
            const index = resultWindows.indexOf(resultWindow);
            if (index > -1) {
                resultWindows.splice(index, 1);
            }
        });
        
        resultWindow.loadFile('result-window.html');
        
        return { success: true };
    } catch (error) {
        console.error('Error opening result window:', error);
        throw error;
    }
});

// Close all result popup windows
ipcMain.handle('close-all-popups', async () => {
    try {
        resultWindows.forEach(win => {
            if (win && !win.isDestroyed()) {
                win.close();
            }
        });
        resultWindows = [];
        return { success: true };
    } catch (error) {
        console.error('Error closing all popups:', error);
        throw error;
    }
});

// Get result data for a specific window
ipcMain.handle('get-result-data', async (event) => {
    try {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) return null;
        
        const windowId = window.id;
        const data = global.resultWindowData?.[windowId];
        
        // Clear the data after retrieving it
        if (global.resultWindowData && windowId in global.resultWindowData) {
            delete global.resultWindowData[windowId];
        }
        
        return data || null;
    } catch (error) {
        console.error('Error getting result data:', error);
        return null;
    }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
