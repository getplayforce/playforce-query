# Playforce Query Configuration Guide

This folder is where you put your Salesforce environment configuration files for Playforce Query. Each environment should have its own JSON file (e.g., dev.json, test.json, prod.json).

**File Naming**: The filename (without the .json extension) appears as the environment name in the application dropdown. For example, `production.json` will appear as "production" in the dropdown.

## Quick Start

1. Create a JSON configuration file in this directory
2. Add your credentials (see examples below)
3. Select the environment from the dropdown in the application
4. Authentication happens automatically!

## Authentication Methods

Playforce Query uses **automatic authentication detection** with the following priority:

1. **Password Grant** - If `username` and `password` are present
2. **Client Credentials** - If only `client_id` and `client_secret` are present (attempted first)
3. **OAuth 2.0 Authorization Code Flow** - If client credentials fail, automatically switches to interactive OAuth

**No need to specify `grant_type`** - Playforce Query chooses the right method!

### Method Comparison

| Method |  Security | User Interaction | Auto-Detected When |
|----------|----------|------------------|-------------------|
| Password Grant | ⚠️ Medium | ❌ No | Config has username + password |
| Client Credentials | ✅ High | ❌ No | No username/password (tried first) |
| OAuth 2.0 (Authorization Code) | ✅ High | ✅ Yes | No username/password (tried second) |


**Recommendation**: Use OAuth 2.0

## Configuration Options

### Required Fields

- `client_id`: The Consumer Key from your Salesforce External Client App
- `client_secret`: The Consumer Secret from your Salesforce External Client App
- `login_url`: The Salesforce login URL
  - Production/Developer orgs: `https://login.salesforce.com`
  - Sandbox orgs: `https://test.salesforce.com`
  - Custom domain: `https://yourdomain.my.salesforce.com`

### Optional Fields

- `username`: Salesforce username
- `password`: Salesforce password 
  -  If a security token is required (for example, if the user's IP address is not trusted) + security token concatenated 
  -  Example: `"password": "MyPasswordMYSECURITYTOKEN"`
- `apiVersion`: Salesforce API version (optional - auto-detected if not specified)
  - **If omitted**: Automatically fetches and uses a stable version from Salesforce
  - **If specified**: Uses the exact version you provide (useful for pinning to a specific version)
  - Examples: `"v58.0"`, `"v59.0"`, `"v60.0"`
  - Format: Must include the `v` prefix

## Setting Up OAuth 2.0 (Authorization Code Flow)

OAuth 2.0 is the recommended method for interactive use. It provides secure authentication without storing passwords.

**Note**: Playforce Query supports both legacy Connected Apps and the newer External Client Apps. For new setups, we recommend using External Client Apps as they provide better support for modern OAuth flows.

### Step 1: Create a External Client App in Salesforce

1. Log in to Salesforce
2. Navigate to **Setup** → **App Manager**  → **External Client Apps** →  **External Client App Manager**
3. Click **New External Client App**
4. Fill in basic information:
   - **External Client App Name**: e.g., "Playforce Query Tool"
   - **Contact Email**: Your email
5. Enable OAuth Settings:
   - Check **Enable OAuth Settings**
   - **Callback URL**: Add **all of these** (for automatic port fallback):
     - `http://localhost:8888/oauth/callback`
     - `http://localhost:8889/oauth/callback`
     - `http://localhost:8890/oauth/callback`
     - `http://localhost:8891/oauth/callback`
     - `http://localhost:8892/oauth/callback`
   - **Why multiple ports?** Playforce Query automatically tries ports 8888-8892 to avoid conflicts with other applications
   - **Selected OAuth Scopes**: Add at least:
     - `Manage user data via APIS (api)`
     - `Perform requests at any time (refresh_token, offline_access)`
   - Unselect check boxes in **Flow Enablement** and **Security**   
   - Select **Enable Authorization Code and Credentials Flow**
     - Alternative is to Select **Enable Client Credentials Flow** for Client Credentials flow that would also need a 'Run As' user specified
   
6. Click **Save**
7. **Wait 2-10 minutes** for the External Client App to propagate
8. Copy your credentials:
   - **Consumer Key** → This is your `client_id`
   - **Consumer Secret** → This is your `client_secret`

### Step 2: Create Configuration File

Create a JSON file in this directory:

```json
{
  "client_id": "3MVG9...YOUR_CONSUMER_KEY",
  "client_secret": "1234567890ABCDEF...YOUR_CONSUMER_SECRET",
  "login_url": "https://login.salesforce.com"
}
```

**That's it!** The system will automatically:
1. Try client credentials authentication
2. Switch to OAuth if client credentials are not available


### Optional Step 3: Restrict or Grant access for Create, Update & Delete
Playforce Query can facilitate CUD operations. If you need to grant or deny for those activities, consult your best practice setup for your site. This could involve use of Permission sets or other arrangements allocated to the External Client App and your users.


## Configuration Examples

### OAuth-Ready Config (Recommended)

```json
{
  "client_id": "3MVG9...",
  "client_secret": "ABC123...",
  "login_url": "https://login.salesforce.com"
}
```

**Behavior**: Automatically detects API version, tries client credentials, switches to OAuth if needed.

### OAuth Config with Pinned API Version

```json
{
  "client_id": "3MVG9...",
  "client_secret": "ABC123...",
  "login_url": "https://login.salesforce.com",
  "apiVersion": "v58.0"
}
```

**Behavior**: Uses the specified API version, tries client credentials, switches to OAuth if needed.

### Password Grant

```json
{
  "client_id": "3MVG9...",
  "client_secret": "ABC123...",  
  "username": "user@example.com",
  "password": "MyPassword123SecToken456",
  "login_url": "https://login.salesforce.com"
}
```

**Behavior**: Uses password grant automatically with auto-detected API version (no OAuth needed).

**Important notes:**
- The `password` field may optionally require your security token appended to your password. Required for example, if the user's IP address is not trusted
  - e.g. If password is `MyPassword123` and token is `SecToken456`, use `MyPassword123SecToken456`
- Security tokens can be reset from Salesforce under: Setup → My Personal Information → Reset My Security Token
- `apiVersion` is optional - omit it to use automatic version detection


## API Version

The `apiVersion` field specifies which Salesforce REST API version to use. **This field is optional** with automatic version detection:


**Format Requirements**:
- Must include the `v` prefix (e.g., `"v58.0"`, `"v59.0"`)
- Use the format `vXX.0` where XX is the version number

### Fallback Behavior

If automatic version detection fails (e.g., network issues), the system falls back to `v57.0`.

## Login URL Behavior

The `login_url` determines which Salesforce instance to authenticate against:

- **Production/Developer orgs**: `https://login.salesforce.com`
- **Sandbox orgs**: `https://test.salesforce.com`
- **Custom domains**: Use your org's My Domain URL
  - Format: `https://yourdomain.my.salesforce.com`
  - Example: `https://acme.my.salesforce.com`

**Important:** 
- Do not include `/services/oauth2/token` or other paths - just the base domain
- Playforce Query automatically appends the OAuth token path
- If authentication fails using the standard login or test domains, check the My Domain page in Salesforce Setup to confirm the correct domain for your org

## Security Notes

- **Access tokens are stored in memory only** per environment and not persisted to disk
- **Token caching** allows switching between environments without re-authentication
- The OAuth callback server only runs on `localhost` (ports 8888-8892) and is not accessible externally
- Client secrets should be kept secure; do not commit config files with real credentials to version control

## Troubleshooting

### "OAuth callback server error" or "Unable to start OAuth callback server"
- **Cause**: Ports 8888-8892 are all in use
- **Solution**: Close other applications using these ports. The app automatically tries 5 different ports to avoid conflicts.

### "redirect_uri_mismatch"
- **Cause**: Callback URL in External Client App doesn't match the port being used
- **Solution**: Ensure the External Client App has **all callback URLs** for ports 8888-8892 (see setup instructions above)

### "invalid_client_id" or "invalid_client"
- **Cause**: Incorrect credentials in config file
- **Solution**: Double-check your `client_id` and `client_secret` in the config file

### "INVALID_SESSION_ID" during query execution
- **Cause**: Token expired or invalid
- **Solution**: Switch to another environment and back - the system will automatically re-authenticate

### External Client App not working immediately
- **Cause**: Salesforce takes 2-10 minutes to propagate new External Client Apps
- **Solution**: Wait a few minutes after creating the External Client App, then try again

### "The requested resource does not exist" or API version errors
- **Cause**: Invalid API version or version format
- **Solution**: 
  - Remove the `apiVersion` field from your config to use automatic detection
  - If specifying manually, ensure format is correct (e.g., `"v58.0"` not `"58.0"`)
  - Check the console logs to see which version was detected/used



