// Intentionally under-hardened serverless handler -- macrc test fixture.
// Demonstrates: module-level cache without distributed backing,
// N sequential DB awaits with no Promise.all, no body size gate.

let cache = null;

const products = ['orders', 'payments', 'inventory'];

export async function handleRequest(client, userId) {
  const a = await client.from('users').select('*').eq('id', userId).maybeSingle();
  const b = await client.from('grants').select('*').eq('user_id', userId).maybeSingle();
  const c = await client.from('catalog').select('*').limit(1);

  const hits = await Promise.all(
    products.map(async (p) => {
      return client.from(p).select('id').eq('user_id', userId).maybeSingle();
    }),
  );

  return { a, b, c, hits };
}
