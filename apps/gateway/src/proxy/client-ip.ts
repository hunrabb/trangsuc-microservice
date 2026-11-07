import { BlockList, isIP } from 'node:net';

const stripMapped = (address: string): string => address.replace(/^::ffff:/i, '');

/** Từ `TRUSTED_PROXIES` đã kiểm tra: danh sách IP hoặc CIDR, phân cách bằng dấu phẩy. */
export function parseTrustedProxies(value: string): BlockList {
  const list = new BlockList();
  for (const entry of value.split(',').map((part) => part.trim())) {
    if (entry === '') {
      continue;
    }
    const [address = '', prefix] = entry.split('/');
    const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) {
      list.addAddress(address, family);
    } else {
      list.addSubnet(address, Number(prefix), family);
    }
  }
  return list;
}

const isTrusted = (address: string, proxies: BlockList): boolean => {
  const family = isIP(address);
  return family !== 0 && proxies.check(address, family === 6 ? 'ipv6' : 'ipv4');
};

/**
 * IP thật của client. Chỉ tin `X-Forwarded-For` khi kết nối tới từ proxy tin cậy, và đọc từ PHẢI sang trái:
 * mỗi proxy thêm địa chỉ nó thấy vào cuối, nên phần đầu chuỗi do client tự viết. Địa chỉ đầu tiên không phải
 * proxy tin cậy chính là client.
 */
export function resolveClientIp(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  proxies: BlockList,
): string | undefined {
  const remote = remoteAddress === undefined ? undefined : stripMapped(remoteAddress);
  if (remote === undefined || !isTrusted(remote, proxies)) {
    return remote;
  }
  const hops = (Array.isArray(forwardedFor) ? forwardedFor.join(',') : (forwardedFor ?? ''))
    .split(',')
    .map((hop) => stripMapped(hop.trim()))
    .filter((hop) => isIP(hop) !== 0);
  for (const hop of hops.reverse()) {
    if (!isTrusted(hop, proxies)) {
      return hop;
    }
  }
  return hops.at(-1) ?? remote;
}
