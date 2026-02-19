#!/usr/bin/env node
/**
 * Granola MCP OAuth Token Flow
 * 
 * 1. Dynamically registers a client
 * 2. Opens browser for authorization
 * 3. Listens for callback on localhost
 * 4. Exchanges code for access + refresh tokens
 * 
 * Usage: node scripts/granola-oauth.js
 */

const http = require("http");
const crypto = require("crypto");
const { execSync } = require("child_process");

const AUTH_BASE = "https://mcp-auth.granola.ai";
const REDIRECT_PORT = 8789;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function main() {
  // Step 1: Dynamic client registration
  console.log("📝 Registering OAuth client...");
  const regRes = await fetch(`${AUTH_BASE}/oauth2/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Ingestion Engine",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });

  if (!regRes.ok) {
    console.error("Registration failed:", await regRes.text());
    process.exit(1);
  }

  const client = await regRes.json();
  console.log("✅ Client registered:", client.client_id);

  // Step 2: Generate PKCE challenge
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(
    crypto.createHash("sha256").update(codeVerifier).digest()
  );
  const state = base64url(crypto.randomBytes(16));

  // Step 3: Build authorization URL
  const authUrl = new URL(`${AUTH_BASE}/oauth2/authorize`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", client.client_id);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("scope", "openid email offline_access");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  // Step 4: Start local server to catch the callback
  const tokenPromise = new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400);
        res.end(`OAuth error: ${error}`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (returnedState !== state) {
        res.writeHead(400);
        res.end("State mismatch");
        server.close();
        reject(new Error("State mismatch"));
        return;
      }

      // Exchange code for tokens
      console.log("🔄 Exchanging code for tokens...");
      try {
        const tokenRes = await fetch(`${AUTH_BASE}/oauth2/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: client.client_id,
            code,
            redirect_uri: REDIRECT_URI,
            code_verifier: codeVerifier,
          }).toString(),
        });

        if (!tokenRes.ok) {
          const txt = await tokenRes.text();
          throw new Error(`Token exchange failed: ${tokenRes.status} ${txt}`);
        }

        const tokens = await tokenRes.json();

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>✅ Granola OAuth Complete!</h1><p>You can close this tab.</p>");
        server.close();
        resolve(tokens);
      } catch (err) {
        res.writeHead(500);
        res.end(`Token exchange failed: ${err.message}`);
        server.close();
        reject(err);
      }
    });

    server.listen(REDIRECT_PORT, () => {
      console.log(`\n🌐 Opening browser for authorization...\n`);
      execSync(`open "${authUrl.toString()}"`);
      console.log(`Waiting for callback on http://localhost:${REDIRECT_PORT}/callback ...\n`);
    });

    // Timeout after 2 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("Timeout waiting for OAuth callback"));
    }, 120000);
  });

  const tokens = await tokenPromise;

  console.log("\n🎉 Tokens obtained!\n");
  console.log("Set these env vars on Vercel:\n");
  console.log(`GRANOLA_MCP_ACCESS_TOKEN=${tokens.access_token}`);
  if (tokens.refresh_token) {
    console.log(`GRANOLA_MCP_REFRESH_TOKEN=${tokens.refresh_token}`);
  }
  console.log(`GRANOLA_MCP_CLIENT_ID=${client.client_id}`);
  console.log(`GRANOLA_MCP_TOKEN_URL=${AUTH_BASE}/oauth2/token`);
}

main().catch((err) => {
  console.error("❌ Failed:", err.message);
  process.exit(1);
});
