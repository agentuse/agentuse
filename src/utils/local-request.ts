import { isIP } from 'node:net';

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  if (address === '::1' || address === 'localhost') return true;
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  if (isIP(normalized) !== 4) return false;
  return normalized.split('.')[0] === '127';
}

export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  const hostname = host.startsWith('[')
    ? host.slice(1, host.indexOf(']'))
    : host.split(':')[0];
  return hostname === 'localhost' || isLoopbackAddress(hostname);
}

/** A native picker selects a folder on the server host, so it is useful only
 * when both the server bind and this browser connection are loopback-local. */
export function canUseHostFolderPicker(bindHost: string, remoteAddress: string | undefined, requestHost?: string): boolean {
  const localBind = bindHost === '127.0.0.1' || bindHost === 'localhost' || bindHost === '::1';
  return localBind && isLoopbackAddress(remoteAddress) && (requestHost === undefined || isLoopbackHostHeader(requestHost));
}
