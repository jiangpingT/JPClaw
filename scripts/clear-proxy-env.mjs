// Preload script to clear proxy environment variables
// This must run BEFORE any other code that might read proxy env vars

delete process.env.http_proxy;
delete process.env.https_proxy;
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.all_proxy;
delete process.env.ALL_PROXY;
delete process.env.no_proxy;
delete process.env.NO_PROXY;

console.error('[clear-proxy-env] Proxy environment variables cleared');
