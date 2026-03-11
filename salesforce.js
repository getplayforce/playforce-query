console.log('salesforce.js loading...');

const fs = require("fs");
const path = require("path");

// Handle both node-fetch v2 and v3
let fetch;
try {
    fetch = require("node-fetch");
    if (typeof fetch !== 'function') {
        fetch = require("node-fetch").default;
    }
    console.log('node-fetch loaded successfully');
} catch (error) {
    console.error('Failed to load node-fetch:', error);
    throw error;
}

console.log('All dependencies loaded successfully');

const CONFIGS_DIR = path.join(__dirname, "configs");

// Ensure configs directory exists
if (!fs.existsSync(CONFIGS_DIR)) {
    fs.mkdirSync(CONFIGS_DIR);
}

let currentConfigFile = null;
let configData = null;
let tokenCache = {}; // Store tokens per config file: { configFileName: tokenData }
let idPrefixCache = {}; // Store ID prefix mappings per config: { configFileName: { prefix: objectType } }
let apiVersionCache = {}; // Store API versions per config file: { configFileName: apiVersion }

function listConfigs() {
    try {
        if (!fs.existsSync(CONFIGS_DIR)) {
            return [];
        }
        const files = fs.readdirSync(CONFIGS_DIR);
        return files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
    } catch (error) {
        console.error('Error listing configs:', error);
        return [];
    }
}

function setConfigFile(configName) {
    try {
        currentConfigFile = path.join(CONFIGS_DIR, `${configName}.json`);
        configData = null; // Reset cached config
        // Don't clear token - keep it in tokenCache for this config

        if (fs.existsSync(currentConfigFile)) {
            console.log('Config file set to:', currentConfigFile);
            return true;
        } else {
            console.error('Config file does not exist:', currentConfigFile);
            currentConfigFile = null;
            return false;
        }
    } catch (error) {
        console.error('Error setting config file:', error);
        currentConfigFile = null;
        return false;
    }
}

function loadConfig() {
    try {
        if (!currentConfigFile) {
            console.warn('No config file selected');
            return null;
        }
        if (!configData && fs.existsSync(currentConfigFile)) {
            console.log('Loading config from:', currentConfigFile);
            configData = JSON.parse(fs.readFileSync(currentConfigFile, "utf-8"));
            console.log('Config loaded successfully');

            // Automatic grant_type determination - only if not explicitly set
            if (!configData.grant_type) {
                if (configData.username && configData.password) {
                    configData.grant_type = "password";
                } else {
                    // No username/password - will try client_credentials first, then OAuth
                    configData.grant_type = "client_credentials";
                }
            }
        }
        return configData;
    } catch (error) {
        console.error('Error loading config:', error);
        return null;
    }
}

// In-memory token management - per config file
function loadToken() {
    if (!currentConfigFile) return null;
    return tokenCache[currentConfigFile] || null;
}

function saveToken(tokenData) {
    if (!currentConfigFile) return;
    tokenCache[currentConfigFile] = tokenData;
    console.log('Token saved in memory for:', path.basename(currentConfigFile));
}

async function authenticate() {
    console.log("authenticate() called");

    const config = loadConfig();
    if (!config) {
        throw new Error("No config selected or config file not found");
    }

    const {
        login_url,
        client_id,
        client_secret,
        grant_type,
        username,
        password,        
    } = config;

    console.log("Using login_url:", login_url);
    console.log("Using grant_type:", grant_type);

    // For authorization_code, we need to trigger the OAuth flow
    if (grant_type === "authorization_code") {
        throw new Error("Please use startOAuthFlow() for authorization_code grant type");
    }

    const body = new URLSearchParams({
        grant_type,
        client_id,
        client_secret
    });

    // Grant-type–specific fields
    switch (grant_type) {
        case "password":
            if (!username || !password) {
                throw new Error("username and password are required for password grant");
            }
            body.append("username", username);
            body.append("password", password);
            break;

        case "client_credentials":
            // No extra fields
            // Note: Salesforce only allows this for specific connected apps
            break;

        default:
            throw new Error(`Unsupported grant_type: ${grant_type}`);
    }

    try {
        console.log("Making authentication request...");
        const res = await fetch(`${login_url}/services/oauth2/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body
        });

        console.log("Authentication response status:", res.status);
        const data = await res.json();

        if (!res.ok) {
            console.error("Authentication failed:", data);
            throw new Error(`Salesforce auth failed: ${JSON.stringify(data)}`);
        }

        console.log("Authentication successful");
        saveToken(data);
        
        return data;
    } catch (error) {
        console.error("Authentication error:", error);
        throw error;
    }
}

// Exchange authorization code for access token
async function authenticateWithAuthCode(authCode, redirectUri) {
    console.log("authenticateWithAuthCode() called");

    const config = loadConfig();
    if (!config) {
        throw new Error("No config selected or config file not found");
    }

    const {
        login_url,
        client_id,
        client_secret
    } = config;

    const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: authCode,
        client_id,
        client_secret,
        redirect_uri: redirectUri
    });

    try {
        console.log("Exchanging authorization code for access token...");
        const res = await fetch(`${login_url}/services/oauth2/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body
        });

        console.log("Token exchange response status:", res.status);
        const data = await res.json();

        if (!res.ok) {
            console.error("Token exchange failed:", data);
            throw new Error(`Salesforce token exchange failed: ${JSON.stringify(data)}`);
        }

        console.log("Token exchange successful");
        saveToken(data);
        return data;
    } catch (error) {
        console.error("Token exchange error:", error);
        throw error;
    }
}

// Generate OAuth authorization URL
function getAuthorizationUrl(redirectUri) {
    const config = loadConfig();
    if (!config) {
        throw new Error("No config selected or config file not found");
    }

    const { login_url, client_id } = config;
    const params = new URLSearchParams({
        response_type: "code",
        client_id,
        redirect_uri: redirectUri,
        prompt: "login"
    });

    return `${login_url}/services/oauth2/authorize?${params.toString()}`;
}

async function getAccessToken(forceRefresh = false) {
    console.log('getAccessToken() called');
    let tokenData = loadToken();

    if (forceRefresh || !tokenData || !tokenData.access_token) {
        console.log('Authenticating to get new token...');
        tokenData = await authenticate();
    } else {
        console.log('Using existing in-memory token');
    }

    return { token: tokenData.access_token, instanceUrl: tokenData.instance_url };
}

async function withTokenRetry(requestFn) {
    try {
        return await requestFn();
    } catch (err) {
        if (err.message.includes("INVALID_SESSION_ID") || err.message.includes("401")) {
            console.warn("Token expired, retrying authentication...");
            const { token, instanceUrl } = await getAccessToken(true); // force refresh
            return await requestFn(token, instanceUrl);
        }
        throw err;
    }
}

// Extract object name from a SOQL query
function extractObjectName(query) {
    // Match FROM <ObjectName> - handle case insensitive and various spacing
    const fromMatch = query.match(/\bFROM\s+([a-zA-Z_][a-zA-Z0-9_]*)/i);
    return fromMatch ? fromMatch[1] : null;
}

// Cache for Tooling API objects per environment (dynamically fetched from Salesforce)
let toolingObjectsCache = {}; // Store per config file: { configFileName: objectNames[] }
let dataObjectsCache = {}; // Store per config file: { configFileName: objectNames[] }

// Fetch available API versions from Salesforce and return the latest
async function fetchApiVersion() {
    try {
        // Need to get instance URL first - either from token or config
        let instanceUrl;
        let token = null;
        const tokenData = loadToken();
        
        if (tokenData && tokenData.instance_url) {
            instanceUrl = tokenData.instance_url;
            token = tokenData.access_token;
        } else {
            // Try to get instance URL from login_url in config
            const config = loadConfig();
            if (!config || !config.login_url) {
                console.warn('Cannot fetch API version: no instance URL available');
                return 'v57.0'; // fallback default
            }
            instanceUrl = config.login_url;
        }
        
        const url = `${instanceUrl}/services/data/`;
        console.log('Fetching available API versions from:', url);
        
        const headers = {
            "Content-Type": "application/json"
        };
        
        // Add authorization if token is available
        if (token) {
            headers["Authorization"] = `Bearer ${token}`;
        }
        
        const res = await fetch(url, {
            headers
        });
        
        if (!res.ok) {
            const text = await res.text();
            console.error('Failed to fetch API versions:', text);
            return 'v57.0'; // fallback default
        }
        
        const versions = await res.json();
        
        if (!Array.isArray(versions) || versions.length === 0) {
            console.error('No API versions returned from Salesforce');
            return 'v57.0'; // fallback default
        }
        
        console.log(`Received ${versions.length} API versions from Salesforce`);
        
        // Use a stable version (second-to-last or latest if only one exists)
        // This avoids using preview/beta versions that might not be fully available
        const versionIndex = versions.length > 1 ? versions.length - 2 : versions.length - 1;
        const selectedVersion = versions[versionIndex];
        let apiVersion = selectedVersion.version;
        
        // Ensure version has 'v' prefix (e.g., "v65.0" not "65.0")
        if (!apiVersion.startsWith('v')) {
            apiVersion = 'v' + apiVersion;
        }
        
        console.log(`Selected API version: ${apiVersion} (using index ${versionIndex} of ${versions.length} versions for stability)`);
        
        // Cache per environment
        if (currentConfigFile) {
            apiVersionCache[currentConfigFile] = apiVersion;
        }
        
        return apiVersion;
    } catch (error) {
        console.error('Error fetching API versions:', error);
        return 'v57.0'; // fallback default
    }
}

// Get API version - from config, cache, or dynamically fetch
async function getApiVersion() {
    const config = loadConfig();
    
    // Priority 1: Use explicitly configured API version
    if (config && config.apiVersion) {
        console.log(`Using configured API version: ${config.apiVersion}`);
        return config.apiVersion;
    }
    
    // Priority 2: Use cached API version for this config
    if (currentConfigFile && apiVersionCache[currentConfigFile]) {
        console.log(`Using cached API version: ${apiVersionCache[currentConfigFile]}`);
        return apiVersionCache[currentConfigFile];
    }
    
    // Priority 3: Fetch from Salesforce
    console.log('No API version configured, fetching from Salesforce...');
    const fetchedVersion = await fetchApiVersion();
    return fetchedVersion;
}

// Fetch list of Tooling API objects from Salesforce
async function fetchToolingObjects() {
    try {
        const config = loadConfig();
        if (!config || !currentConfigFile) {
            console.warn('No config selected, cannot fetch Tooling API objects');
            return null;
        }
        
        const apiVersion = await getApiVersion();
        const { token, instanceUrl } = await getAccessToken();
        
        const url = `${instanceUrl}/services/data/${apiVersion}/tooling/sobjects/`;
        console.log('Fetching Tooling API objects from:', url);
        
        const res = await fetch(url, {
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
            }
        });
        
        if (!res.ok) {
            const text = await res.text();
            console.error('Failed to fetch Tooling API objects:', text);
            return null;
        }
        
        const result = await res.json();
        const toolingSObjects = result.sobjects || [];
        console.log(`Fetched ${toolingSObjects.length} Tooling API objects for ${path.basename(currentConfigFile)}`);
        
        // Cache per environment
        toolingObjectsCache[currentConfigFile] = toolingSObjects;
        return toolingSObjects;
    } catch (error) {
        console.error('Error fetching Tooling API objects:', error);
        return null;
    }
}

// Extract object name from a SOQL query, REST path, or plain object name
function extractObjectNameFromInput(input) {
    if (!input) return null;
    
    // Try to extract from FROM clause (SOQL query)
    const fromMatch = input.match(/\bFROM\s+([a-zA-Z_][a-zA-Z0-9_]*)/i);
    if (fromMatch) {
        return fromMatch[1];
    }
    
    // Try first path segment (REST path like "Account/001..." or plain "Account")
    const pathMatch = input.match(/^([a-zA-Z_][a-zA-Z0-9_]*)/);
    if (pathMatch) {
        return pathMatch[1];
    }
    
    return null;
}

// Check if an object name is a Tooling API object
function isToolingObject(objectName) {
    if (!objectName || !currentConfigFile) {
        return false;
    }
    
    // Get cached lists for current environment
    const toolingObjectsList = toolingObjectsCache[currentConfigFile];
    const dataObjectsList = dataObjectsCache[currentConfigFile];
    
    // If not cached, trigger fetch in background and return false for now
    if (!toolingObjectsList || !Array.isArray(toolingObjectsList) || toolingObjectsList.length === 0) {
        console.log('Tooling API objects not yet cached, fetching in background...');
        fetchToolingObjects().catch(err => 
            console.error('Background fetch of Tooling API objects failed:', err)
        );
        return false;
    }
    
    if (!dataObjectsList || !Array.isArray(dataObjectsList) || dataObjectsList.length === 0) {
        console.log('Data API objects not yet cached, fetching in background...');
        describeGlobal().then(result => {
            dataObjectsCache[currentConfigFile] = result.sobjects || [];
        }).catch(err => 
            console.error('Background fetch of Data API objects failed:', err)
        );
        return false;
    }
    
    // Check if object exists in Tooling API
    const inTooling = toolingObjectsList.some(obj => 
        obj && obj.name && obj.name.toLowerCase() === objectName.toLowerCase()
    );
    
    if (!inTooling) {
        return false;
    }
    
    // Check if object also exists in Data API
    const inData = dataObjectsList.some(obj => 
        obj && obj.name && obj.name.toLowerCase() === objectName.toLowerCase()
    );
    
    // If object exists in both APIs, prefer Data API (has more complete fields)
    if (inData) {
        console.log(`${objectName} exists in both APIs - using Data API for complete fields`);
        return false;
    }
    
    // Object only exists in Tooling API
    console.log(`${objectName} only in Tooling API - using Tooling API`);
    return true;
}

// Detect if a query or path should use Tooling API
function shouldUseToolingAPI(queryOrPath) {
    const objectName = extractObjectNameFromInput(queryOrPath);
    return isToolingObject(objectName);
}

// Recursively merge API responses, preferring Data API scalar values on conflicts
function mergeApiResults(dataValue, toolingValue) {
    if (dataValue === undefined) return toolingValue;
    if (toolingValue === undefined) return dataValue;

    if (Array.isArray(dataValue) && Array.isArray(toolingValue)) {
        const combined = [...toolingValue, ...dataValue];
        const seen = new Set();
        return combined.filter(item => {
            const key = (item && typeof item === 'object') ? JSON.stringify(item) : String(item);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    const isDataObject = dataValue && typeof dataValue === 'object' && !Array.isArray(dataValue);
    const isToolingObjectValue = toolingValue && typeof toolingValue === 'object' && !Array.isArray(toolingValue);

    if (isDataObject && isToolingObjectValue) {
        const merged = { ...toolingValue, ...dataValue };
        const keys = new Set([...Object.keys(toolingValue), ...Object.keys(dataValue)]);
        for (const key of keys) {
            if (Object.prototype.hasOwnProperty.call(dataValue, key) && Object.prototype.hasOwnProperty.call(toolingValue, key)) {
                merged[key] = mergeApiResults(dataValue[key], toolingValue[key]);
            }
        }
        return merged;
    }

    // Prefer Data API values for scalar conflicts
    return dataValue;
}

// Collect field paths that exist in Tooling API response but not in Data API response
function collectToolingOnlyFieldPaths(dataValue, toolingValue, basePath = '') {
    const paths = [];

    const isDataObject = dataValue && typeof dataValue === 'object' && !Array.isArray(dataValue);
    const isToolingObjectValue = toolingValue && typeof toolingValue === 'object' && !Array.isArray(toolingValue);

    if (!isToolingObjectValue) {
        return paths;
    }

    if (!isDataObject) {
        return paths;
    }

    for (const key of Object.keys(toolingValue)) {
        const path = basePath ? `${basePath}.${key}` : key;
        const hasInData = Object.prototype.hasOwnProperty.call(dataValue, key);

        if (!hasInData) {
            paths.push(path);
            continue;
        }

        const nestedPaths = collectToolingOnlyFieldPaths(dataValue[key], toolingValue[key], path);
        if (nestedPaths.length > 0) {
            paths.push(...nestedPaths);
        }
    }

    return paths;
}

async function getObjectApiAvailability(objectName) {
    if (!objectName || !currentConfigFile) {
        return { inData: false, inTooling: false, inBoth: false };
    }

    let toolingObjectsList = toolingObjectsCache[currentConfigFile];
    let dataObjectsList = dataObjectsCache[currentConfigFile];

    if (!toolingObjectsList || !Array.isArray(toolingObjectsList) || toolingObjectsList.length === 0) {
        toolingObjectsList = await fetchToolingObjects();
    }

    if (!dataObjectsList || !Array.isArray(dataObjectsList) || dataObjectsList.length === 0) {
        const globalResult = await describeGlobal();
        dataObjectsList = globalResult?.sobjects || [];
    }

    const lowerName = objectName.toLowerCase();
    const inTooling = Array.isArray(toolingObjectsList) && toolingObjectsList.some(obj =>
        obj && obj.name && obj.name.toLowerCase() === lowerName
    );
    const inData = Array.isArray(dataObjectsList) && dataObjectsList.some(obj =>
        obj && obj.name && obj.name.toLowerCase() === lowerName
    );

    return {
        inData,
        inTooling,
        inBoth: inData && inTooling
    };
}

// Expand SELECT * to actual field names
async function expandSelectStar(query) {
    // Check if query contains SELECT *
    const selectStarPattern = /\bSELECT\s+\*/i;
    if (!selectStarPattern.test(query)) {
        // No SELECT * found, return original query
        return query;
    }

    console.log('Detected SELECT * - expanding to all field names...');
    
    // Extract the object name
    const objectName = extractObjectName(query);
    if (!objectName) {
        console.error('Could not extract object name from query');
        return query;
    }

    try {
        // Get the object metadata
        const metadata = await describeObject(objectName);
        
        // Get all field names
        const fieldNames = metadata.fields.map(field => field.name);
        
        if (fieldNames.length === 0) {
            console.warn('No fields found for object:', objectName);
            return query;
        }

        // Replace SELECT * with field names
        const expandedQuery = query.replace(selectStarPattern, `SELECT ${fieldNames.join(', ')}`);
        console.log(`Expanded SELECT * to ${fieldNames.length} fields for ${objectName}`);
        
        return expandedQuery;
    } catch (error) {
        console.error('Error expanding SELECT *:', error);
        // Return original query if expansion fails
        return query;
    }
}

async function executeSOQL(query, onProgress = null, abortSignal = null) {
    console.log('executeSOQL called with:', query);
    
    // Detect if this query uses Tooling API objects
    const useTooling = shouldUseToolingAPI(query);
    
    // Check license for Tooling API
    if (useTooling) {
        const licenseStatus = checkLicense();
        if (!licenseStatus.licensed) {
            throw new Error(`License required for Tooling API access. ${licenseStatus.message} Visit https://getplayforce.com to get a license and paste it into your .env file.`);
        }
    }
    
    // Expand SELECT * if present
    query = await expandSelectStar(query);
    
    const config = loadConfig();
    const apiVersion = await getApiVersion();

    return await withTokenRetry(async (token, instanceUrl) => {
        if (!token || !instanceUrl) {
            ({ token, instanceUrl } = await getAccessToken());
        }

        // Use /services/data/v##.0/tooling/query or /services/data/v##.0/query
        const toolingPath = useTooling ? '/tooling' : '';
        const url = `${instanceUrl}/services/data/${apiVersion}${toolingPath}/query/?q=${encodeURIComponent(query)}`;
        console.log(`Making ${useTooling ? 'Tooling API' : 'Data API'} SOQL request to:`, url);

        const fetchOptions = {
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
            }
        };
        if (abortSignal) {
            fetchOptions.signal = abortSignal;
        }

        const res = await fetch(url, fetchOptions);

        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Salesforce SOQL error: ${text}`);
        }

        const result = await res.json();
        console.log('SOQL success, returned', result.totalSize, 'records');
        
        // Add metadata about which API was used
        result._apiType = useTooling ? 'tooling' : 'data';
        
        // If there are more records, fetch them automatically
        if (result.nextRecordsUrl) {
            console.log('Fetching additional pages...');
            let allRecords = result.records || [];
            let nextUrl = result.nextRecordsUrl;
            let pageCount = 1;
            
            // Report initial batch if callback provided
            if (onProgress) {
                onProgress({
                    records: allRecords,
                    totalSize: result.totalSize,
                    fetchedCount: allRecords.length,
                    done: false,
                    pageNumber: pageCount
                });
            }
            
            // Fetch remaining pages
            while (nextUrl) {
                pageCount++;
                const pageUrl = `${instanceUrl}${nextUrl}`;
                console.log(`Fetching page ${pageCount}:`, pageUrl);
                
                const pageFetchOptions = {
                    headers: {
                        "Authorization": `Bearer ${token}`,
                        "Content-Type": "application/json"
                    }
                };
                if (abortSignal) {
                    pageFetchOptions.signal = abortSignal;
                }
                
                const pageRes = await fetch(pageUrl, pageFetchOptions);
                
                if (!pageRes.ok) {
                    const text = await pageRes.text();
                    console.error(`Error fetching page ${pageCount}:`, text);
                    break;
                }
                
                const pageData = await pageRes.json();
                allRecords = allRecords.concat(pageData.records || []);
                nextUrl = pageData.nextRecordsUrl;
                
                console.log(`Page ${pageCount} fetched: ${pageData.records?.length || 0} records, total so far: ${allRecords.length}`);
                
                // Report progress if callback provided
                if (onProgress) {
                    onProgress({
                        records: allRecords,
                        totalSize: result.totalSize,
                        fetchedCount: allRecords.length,
                        done: !nextUrl,
                        pageNumber: pageCount
                    });
                }
            }
            
            // Return complete result with all records
            return {
                ...result,
                records: allRecords,
                done: true,
                _apiType: useTooling ? 'tooling' : 'data'
            };
        }
        
        return result;
    });
}

function checkLicense() {
    // Load license from .env file in root directory
    let licenseKey = null;
    const envPath = path.join(__dirname, '.env');
    
    if (fs.existsSync(envPath)) {
        try {
            const envContent = fs.readFileSync(envPath, 'utf8');
            const match = envContent.match(/^PLAYFORCE_LICENSE=(.*)$/m);
            if (match) {
                licenseKey = match[1].trim().replace(/^['"]|['"]$/g, ''); // Remove quotes if present
            }
        } catch (e) {
            console.error('Error reading .env file:', e);
        }
    }
    
    if (!licenseKey) {
        return { licensed: false, message: 'No license key configured.' };
    }
    
    try {
        const crypto = require('crypto');
        
        // Your public key (hardcoded - safe to expose)
        const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAn2cQarzuH9IGlOkhYnza
hueM6jhtP0mSZNQTORzp3ZcBs1Q5NqeG2SHNuCoVBlrI5iQaS9aIWAve8gOQC2DA
1WXq+WmHsjzChrHFKz3FLRgIljSg49DZ68kUmjbkvVFJolXZGyvKmXbq7ExJr1FJ
szjMCzMNvf/hG4zMmV3Pa4E2ldavejTFVuACzsy0ToH4SofnVYo5X8YIC9xhdvIT
n3dZydOs43PQb/yB3thIfDMd0lrV9xInH+by465gWMHZQLCqDtg+wLxglb5dz3mV
YLL4vX5BZrFtcjaadLaRTeD/+HZBsK/6KCjZU0DGipFjrccXylif2FxLT9lZZf7o
CQIDAQAB
-----END PUBLIC KEY-----`;
        
        // License format: base64 encoded JSON with { data: {...}, signature: Buffer }
        let licenseJson;
        try {
            const decoded = Buffer.from(licenseKey, 'base64').toString('utf8');
            licenseJson = JSON.parse(decoded);
        } catch (e) {
            return { licensed: false, message: 'Invalid license format. Unable to decode license.' };
        }
        
        if (!licenseJson.data || !licenseJson.signature) {
            return { licensed: false, message: 'Invalid license structure. Missing data or signature.' };
        }
        
        const licenseInfo = licenseJson.data;
        const signatureData = licenseJson.signature;
        
        // Convert signature from Buffer format to actual Buffer
        let signatureBuffer;
        if (signatureData.type === 'Buffer' && Array.isArray(signatureData.data)) {
            signatureBuffer = Buffer.from(signatureData.data);
        } else {
            return { licensed: false, message: 'Invalid signature format in license.' };
        }
        
        // Verify signature - sign the JSON string of the data
        const dataString = JSON.stringify(licenseInfo);
        const isValid = crypto.verify(
            'sha256', 
            Buffer.from(dataString), 
            {
                key: PUBLIC_KEY,
                padding: crypto.constants.RSA_PKCS1_PADDING
            }, 
            signatureBuffer
        );
        
        if (!isValid) {
            return { licensed: false, message: 'Invalid license signature.' };
        }
        
        // Validate license info structure
        if (!licenseInfo.organization || !licenseInfo.licenseeEmail) {
            return { licensed: false, message: 'Invalid license data.' };
        }
        
        // Check if license is active
        const now = new Date();
        const startDate = new Date(licenseInfo.startDateUTC);
        const paidEndDate = new Date(licenseInfo.paidEndDateUTC);
        const freeEndDate = new Date(licenseInfo.freeEndDateUTC);
        
        if (now < startDate) {
            return { licensed: false, message: 'License not yet active' };
        }
        
        const isPaidActive = paidEndDate && now <= paidEndDate;
        const isFreeActive = freeEndDate && now <= freeEndDate;
        
        if (!isPaidActive && !isFreeActive) {
            return { licensed: false, message: 'License expired.' };
        }
        
        return { 
            licensed: true, 
            organization: licenseInfo.organization,
            email: licenseInfo.licenseeEmail,
            tier: licenseInfo.tier,
            freeEndDateUTC: licenseInfo.freeEndDateUTC,
            isPaid: isPaidActive
        };
        
    } catch (e) {
        console.error('License validation error:', e);
        return { licensed: false, message: `Validation error: ${e.message}.` };
    }
}

async function executeREST(path, method = 'GET', body = null, headers = null, onProgress = null, abortSignal = null, apiMode = null) {
    const config = loadConfig();
    const apiVersion = await getApiVersion();
    const normalizedMethod = (method || 'GET').toUpperCase();
    const objectName = extractObjectNameFromInput(path);
    const availability = await getObjectApiAvailability(objectName);
    const isDataOnlyWriteMethod = normalizedMethod === 'PUT' || normalizedMethod === 'PATCH' || normalizedMethod === 'DELETE';
    const isBothApiCandidate = normalizedMethod === 'GET' && availability.inBoth;

    if (isDataOnlyWriteMethod && !availability.inData) {
        throw new Error(`${normalizedMethod} is only supported on Data API objects. ${objectName || 'This object'} is not available in Data API.`);
    }

    let useBothApis = availability.inBoth && !isDataOnlyWriteMethod;
    let useTooling = availability.inTooling && !availability.inData && !isDataOnlyWriteMethod;

    if (!isDataOnlyWriteMethod && normalizedMethod === 'GET') {
        if (apiMode === 'data' && availability.inData) {
            useBothApis = false;
            useTooling = false;
        } else if (apiMode === 'tooling' && availability.inTooling) {
            useBothApis = false;
            useTooling = true;
        }
    }
    
    // Check license for write operations or Tooling API
    if (normalizedMethod !== 'GET' || useTooling || useBothApis) {
        const licenseStatus = checkLicense();
        if (!licenseStatus.licensed) {
            const reason = useBothApis ? 'merged Data + Tooling API access' : (useTooling ? 'Tooling API access' : 'write operations');
            throw new Error(`License required for ${reason}. ${licenseStatus.message} Copy .env.example to .env, then visit https://getplayforce.com to get a free license and paste it in.`);
        }
    }

    return await withTokenRetry(async (token, instanceUrl) => {
        if (!token || !instanceUrl) {
            ({ token, instanceUrl } = await getAccessToken());
        }

        const callRestApi = async (toolingEnabled) => {
            const toolingPath = toolingEnabled ? '/tooling' : '';
            const url = `${instanceUrl}/services/data/${apiVersion}${toolingPath}/sobjects/${path}`;
            console.log(`Making ${normalizedMethod} ${toolingEnabled ? 'Tooling API' : 'Data API'} REST request to:`, url);
            if (headers) {
                console.log('Custom headers:', JSON.stringify(headers));
            }
            if (body) {
                console.log('Request body:', JSON.stringify(body));
            }

            const fetchOptions = {
                method: normalizedMethod,
                headers: {
                    "Authorization": `Bearer ${token}`,
                    "Content-Type": "application/json",
                    ...(headers || {})
                }
            };

            if (abortSignal) {
                fetchOptions.signal = abortSignal;
            }

            if (body && (normalizedMethod === 'POST' || normalizedMethod === 'PATCH' || normalizedMethod === 'PUT')) {
                fetchOptions.body = JSON.stringify(body);
            }

            const res = await fetch(url, fetchOptions);

            if (!res.ok) {
                const text = await res.text();
                throw new Error(`REST API error: ${text}\nURL: ${url}`);
            }

            const contentType = res.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
                return await res.json();
            }

            return { success: true, status: res.status };
        };

        if (useBothApis) {
            const emitProgress = (payload) => {
                if (typeof onProgress === 'function') {
                    try {
                        onProgress(payload);
                    } catch (progressError) {
                        console.warn('REST progress callback error:', progressError?.message || progressError);
                    }
                }
            };

            const dataPromise = callRestApi(false)
                .then((value) => {
                    emitProgress({
                        phase: 'partial',
                        source: 'data',
                        pending: ['tooling'],
                        result: {
                            ...value,
                            _apiType: 'data'
                        }
                    });
                    return value;
                })
                .catch((error) => {
                    emitProgress({
                        phase: 'partial-error',
                        source: 'data',
                        pending: ['tooling'],
                        error: error?.message || String(error)
                    });
                    throw error;
                });

            const toolingPromise = callRestApi(true)
                .then((value) => {
                    emitProgress({
                        phase: 'partial',
                        source: 'tooling',
                        pending: ['data'],
                        result: {
                            ...value,
                            _apiType: 'tooling'
                        }
                    });
                    return value;
                })
                .catch((error) => {
                    emitProgress({
                        phase: 'partial-error',
                        source: 'tooling',
                        pending: ['data'],
                        error: error?.message || String(error)
                    });
                    throw error;
                });

            const [dataResultSettled, toolingResultSettled] = await Promise.allSettled([
                dataPromise,
                toolingPromise
            ]);

            if (dataResultSettled.status === 'rejected' && toolingResultSettled.status === 'rejected') {
                throw new Error(`REST API error (both failed):\nData: ${dataResultSettled.reason?.message || dataResultSettled.reason}\nTooling: ${toolingResultSettled.reason?.message || toolingResultSettled.reason}`);
            }

            if (dataResultSettled.status === 'fulfilled' && toolingResultSettled.status === 'fulfilled') {
                const merged = mergeApiResults(dataResultSettled.value, toolingResultSettled.value);
                merged._toolingFieldPaths = collectToolingOnlyFieldPaths(dataResultSettled.value, toolingResultSettled.value);
                merged._dataPayload = dataResultSettled.value;
                merged._toolingPayload = toolingResultSettled.value;
                merged._apiType = 'both';
                merged._apiCandidateBoth = isBothApiCandidate;
                return merged;
            }

            // Partial success fallback (still provide successful response)
            const successfulResult = dataResultSettled.status === 'fulfilled'
                ? { ...dataResultSettled.value, _apiType: 'data' }
                : { ...toolingResultSettled.value, _apiType: 'tooling' };

            const dataError = dataResultSettled.status === 'rejected' ? dataResultSettled.reason : null;
            const toolingError = toolingResultSettled.status === 'rejected' ? toolingResultSettled.reason : null;
            const isAbortError = (error) =>
                !!error && (
                    error.name === 'AbortError' ||
                    (typeof error.message === 'string' && (error.message.includes('aborted') || error.message.includes('AbortError')))
                );

            successfulResult._mergeWarning = dataResultSettled.status === 'rejected'
                ? `Data API failed: ${dataError?.message || dataError}`
                : `Tooling API failed: ${toolingError?.message || toolingError}`;
            successfulResult._apiCandidateBoth = isBothApiCandidate;

            if (isAbortError(dataError) || isAbortError(toolingError)) {
                successfulResult.aborted = true;
                successfulResult._abortedPending = [
                    isAbortError(dataError) ? 'data' : null,
                    isAbortError(toolingError) ? 'tooling' : null
                ].filter(Boolean);
            }

            return successfulResult;
        }

        const resultData = await callRestApi(useTooling);
        resultData._apiType = useTooling ? 'tooling' : 'data';
        resultData._apiCandidateBoth = isBothApiCandidate;
        return resultData;
    });
}

// Get current config info for debugging
function getCurrentConfig() {
    const hasToken = currentConfigFile ? !!tokenCache[currentConfigFile] : false;
    const token = currentConfigFile ? tokenCache[currentConfigFile] : null;
    return {
        currentConfigFile,
        hasConfigData: !!configData,
        hasToken,
        instanceUrl: token?.instance_url || null
    };
}

// Check if current config requires OAuth
function requiresOAuth() {
    // We'll always try client_credentials first, then fall back to OAuth
    return false;
}

// Check if we have a cached token for current config
function hasValidToken() {
    const token = loadToken();
    return !!token && !!token.access_token;
}

// Try to authenticate with automatic fallback from client_credentials to OAuth
async function tryAuthenticate() {
    const config = loadConfig();
    if (!config) {
        throw new Error("No config selected or config file not found");
    }

    // If it has username/password, use password grant
    if (config.username && config.password) {
        console.log('Using password grant');
        await authenticate();
        return { success: true, method: 'password' };
    }

    // Otherwise, try client_credentials first
    console.log('Attempting client_credentials authentication...');
    try {
        await authenticate();
        console.log('Client credentials authentication successful');
        return { success: true, method: 'client_credentials' };
    } catch (error) {
        console.log('Client credentials failed, OAuth required:', error.message);
        return { success: false, needsOAuth: true, error: error.message };
    }
}

// Get list of all available SObjects
async function describeGlobal() {
    console.log('describeGlobal() called');
    const config = loadConfig();
    if (!config) {
        throw new Error('No config selected. Please select an environment first.');
    }
    const apiVersion = await getApiVersion();

    return await withTokenRetry(async (token, instanceUrl) => {
        if (!token || !instanceUrl) {
            ({ token, instanceUrl } = await getAccessToken());
        }

        const url = `${instanceUrl}/services/data/${apiVersion}/sobjects/`;
        console.log('Making describeGlobal request to:', url);

        const res = await fetch(url, {
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
            }
        });

        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Salesforce describe global error: ${text}`);
        }

        const result = await res.json();
        console.log('describeGlobal success, returned', result.sobjects?.length || 0, 'objects');
        
        // Cache the Data API objects for this environment
        if (currentConfigFile && result.sobjects) {
            dataObjectsCache[currentConfigFile] = result.sobjects;
        }
        
        return result;
    });
}

// Get field metadata for a specific SObject
async function describeObject(objectName) {
    console.log('describeObject() called for:', objectName);
    const config = loadConfig();
    if (!config) {
        throw new Error('No config selected. Please select an environment first.');
    }
    const apiVersion = await getApiVersion();
    
    // Detect if this object uses Tooling API
    const useTooling = shouldUseToolingAPI(objectName);

    return await withTokenRetry(async (token, instanceUrl) => {
        if (!token || !instanceUrl) {
            ({ token, instanceUrl } = await getAccessToken());
        }

        const toolingPath = useTooling ? '/tooling' : '';
        const url = `${instanceUrl}/services/data/${apiVersion}${toolingPath}/sobjects/${objectName}/describe`;
        console.log(`Making ${useTooling ? 'Tooling API' : 'Data API'} describeObject request to:`, url);

        const res = await fetch(url, {
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
            }
        });

        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Salesforce describe object error: ${text}`);
        }

        const result = await res.json();
        console.log('describeObject success, returned', result.fields?.length || 0, 'fields for', objectName);
        return result;
    });
}

// Fetch and cache ID prefixes for all objects
async function fetchIdPrefixes() {
    console.log('fetchIdPrefixes() called');
    
    if (!currentConfigFile) {
        throw new Error('No config selected');
    }
    
    // Check if already cached for this config
    if (idPrefixCache[currentConfigFile]) {
        console.log('Using cached ID prefixes for', path.basename(currentConfigFile));
        return idPrefixCache[currentConfigFile];
    }
    
    try {
        let dataSObjects;
        let toolingSObjects = [];

        // First check if dataObjectsCache already has the sobjects (from fetchSObjects)
        if (dataObjectsCache[currentConfigFile] && dataObjectsCache[currentConfigFile].length > 0) {
            console.log('Using sobjects from dataObjectsCache for ID prefixes');
            dataSObjects = dataObjectsCache[currentConfigFile];
        } else {
            // Fetch describe global to get all objects with their key prefixes
            // This will also populate dataObjectsCache automatically
            const describeResult = await describeGlobal();

            if (!describeResult || !describeResult.sobjects) {
                console.warn('No sobjects returned from describeGlobal');
                return {};
            }

            dataSObjects = describeResult.sobjects;
        }

        // Fetch tooling objects as well to resolve tooling-only ID prefixes (best effort)
        const toolingResult = await fetchToolingObjects();
        if (Array.isArray(toolingResult)) {
            toolingSObjects = toolingResult;
        }

        const prefixMap = {};

        // Build prefix -> object type mapping from Tooling first
        for (const sobject of toolingSObjects) {
            if (sobject && sobject.keyPrefix && sobject.name) {
                prefixMap[sobject.keyPrefix] = sobject.name;
            }
        }

        // Then overlay Data API mappings (prefer Data on conflicts)
        for (const sobject of dataSObjects) {
            if (sobject && sobject.keyPrefix && sobject.name) {
                prefixMap[sobject.keyPrefix] = sobject.name;
            }
        }
        
        // Cache the result
        idPrefixCache[currentConfigFile] = prefixMap;
        console.log(`Cached ${Object.keys(prefixMap).length} ID prefixes for ${path.basename(currentConfigFile)}`);
        
        return prefixMap;
    } catch (error) {
        console.error('Error fetching ID prefixes:', error);
        return {};
    }
}

// Get object type from a Salesforce ID
async function getObjectTypeFromId(recordId) {
    if (!recordId || typeof recordId !== 'string') {
        return null;
    }
    
    // Salesforce IDs are 15 or 18 characters
    if (recordId.length !== 15 && recordId.length !== 18) {
        return null;
    }
    
    // Extract the 3-character prefix
    const prefix = recordId.substring(0, 3);
    
    // Get or fetch the prefix mapping
    let prefixMap = idPrefixCache[currentConfigFile];
    
    if (!prefixMap) {
        prefixMap = await fetchIdPrefixes();
    }
    
    const objectType = prefixMap[prefix];
    
    if (objectType) {
        console.log(`ID ${recordId} -> prefix ${prefix} -> object type ${objectType}`);
    } else {
        console.warn(`Unknown ID prefix: ${prefix} for ID ${recordId}`);
    }
    
    return objectType || null;
}

function getLicenseInfo() {
    return checkLicense();
}

// Fetch the active UI theme from Salesforce to get the org's header color
async function fetchActiveTheme() {
    const apiVersion = await getApiVersion();

    return await withTokenRetry(async (token, instanceUrl) => {
        if (!token || !instanceUrl) {
            ({ token, instanceUrl } = await getAccessToken());
        }

        const url = `${instanceUrl}/services/data/${apiVersion}/ui-api/themes/active`;
        console.log('Fetching active theme from:', url);

        const res = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Failed to fetch active theme: ${text}`);
        }

        return await res.json();
    });
}

module.exports = {
    executeSOQL,
    executeREST,
    setConfigFile,
    listConfigs,
    getAccessToken,
    getAuthorizationUrl,
    authenticateWithAuthCode,
    getCurrentConfig,
    requiresOAuth,
    tryAuthenticate,
    hasValidToken,
    describeGlobal,
    describeObject,
    getLicenseInfo,
    fetchToolingObjects,
    fetchIdPrefixes,
    getObjectTypeFromId,
    getApiVersion,
    fetchActiveTheme,
};

console.log('salesforce.js loaded successfully');
