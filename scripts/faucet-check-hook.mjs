// Test-only resolve hook: dev.routes.ts imports the login middleware, and a
// Privy token cannot be minted here, so that one import is pointed at a stub.
export async function resolve(specifier, context, next) {
  if (/auth\.middleware\.(js|ts)$/.test(specifier) && context.parentURL?.includes("dev.routes")) {
    return { url: new URL("./faucet-check-stub-auth.mjs", import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
