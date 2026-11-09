// Pure guards, shared by prepared 6.5B tools. Importing this file performs no I/O.
export const ACK = 'I_ACKNOWLEDGE_ISOLATED_PHASE6_TEST';
export function requireAcknowledgement(env = process.env) {
  if (env.PHASE6_TEST_EXECUTE !== ACK)
    throw new Error('6.5B is opt-in; explicit isolated-test acknowledgement required');
}
export function databaseUrl(input, schema) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Missing/invalid isolated test database URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '55432' ||
    url.pathname !== '/phase6_test' ||
    url.username !== `${schema}_user` ||
    !url.password ||
    url.searchParams.get('schema') !== schema
  )
    throw new Error('Only phase6_test on loopback:55432 with the service role/schema is allowed');
  return input;
}
export function gatewayUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Missing/invalid isolated Gateway URL');
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '3090' ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error('Only isolated Gateway http://127.0.0.1:3090 is allowed');
  return url.origin;
}
export function rabbitUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Missing/invalid isolated broker URL');
  }
  if (
    url.protocol !== 'amqp:' ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '55672' ||
    url.username !== 'phase6_app' ||
    !url.password ||
    decodeURIComponent(url.pathname.slice(1)) !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Only isolated phase6_app broker on loopback:55672 is allowed');
  return input;
}
export const FIXTURE = Object.freeze({
  category: '65000000-0000-4000-8000-000000000001',
  metal: '65000000-0000-4000-8000-000000000002',
  product: '65000000-0000-4000-8000-000000000003',
  variant: '65000000-0000-4000-8000-000000000004',
  warehouse: '65000000-0000-4000-8000-000000000005',
  branch: '65000000-0000-4000-8000-000000000006',
  item: '65000000-0000-4000-8000-000000000007',
});
