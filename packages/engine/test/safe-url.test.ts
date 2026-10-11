import { describe, expect, it } from 'vitest';
import { assertPublicUrl, isPrivateAddress } from '../src/safe-url.ts';

describe('webhook addresses', () => {
  it('knows private and public addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.1', '169.254.169.254', '169.254.170.2', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1'])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '203.0.113.10', '172.32.0.1', '2a00:1450:4009::200e', '::ffff:8.8.8.8']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('refuses http, localhost and names that point inside', async () => {
    const pub = async () => ['8.8.8.8'];
    await expect(assertPublicUrl('https://hooks.saleane.com/email', pub)).resolves.toBeUndefined();
    await expect(assertPublicUrl('http://hooks.saleane.com/email', pub)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(assertPublicUrl('https://localhost:8787/', pub)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(assertPublicUrl('https://169.254.169.254/latest/meta-data', pub)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(assertPublicUrl('https://[::1]/', pub)).rejects.toMatchObject({ code: 'invalid_request' });
    // A public-looking name that resolves to a private address, as in DNS rebinding.
    await expect(assertPublicUrl('https://rebind.example.com/', async () => ['8.8.8.8', '10.0.0.7'])).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(assertPublicUrl('https://nowhere.example/', async () => [])).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
