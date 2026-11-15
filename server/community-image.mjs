export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_DATA_URL_LENGTH = 4 * Math.ceil(MAX_IMAGE_BYTES / 3) + 32;

export function normalizeCommunityImageUrl(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.length > 2000) throw new Error('Image link must be an HTTPS image URL up to 2,000 characters.');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter a valid image link.'); }
  const hosts = ['i.imgur.com', 'imgur.com', 'www.imgur.com', 'cdn.discordapp.com', 'media.discordapp.net', 'images.unsplash.com', 'upload.wikimedia.org'];
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.includes(url.hostname)) throw new Error('Use an HTTPS image link from Imgur, Discord CDN, Unsplash or Wikimedia.');
  if (url.hostname === 'imgur.com' || url.hostname === 'www.imgur.com') {
    const id = /^\/([A-Za-z0-9]+)(?:\.(?:png|jpe?g|webp))?\/?$/.exec(url.pathname)?.[1];
    if (!id) throw new Error('Use a single Imgur image link, not an album.');
    url = new URL(`https://i.imgur.com/${id}.jpg`);
  }
  url.hash = '';
  return url.href;
}

/** Only bounded raster data URLs are accepted; never fetch a client-provided URL. */
export function decodeCommunityImage(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_IMAGE_DATA_URL_LENGTH) throw new Error('Image must be a PNG, JPEG or WebP of at most 4 MiB.');
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new Error('Image must be a Base64 PNG, JPEG or WebP data URL.');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== match[2]) throw new Error('Image encoding is invalid or exceeds 4 MiB.');
  const mimeType = match[1];
  const matchesType = mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mimeType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!matchesType) throw new Error('Image bytes do not match the declared file type.');
  return { bytes, mimeType, base64: match[2], dataUrl: value, filename: `report.${mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1]}` };
}
