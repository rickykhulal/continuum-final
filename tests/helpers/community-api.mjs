// Test-only current-weather transport. Production has no fixture switch.
const actualFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === 'api.open-meteo.com' && url.searchParams.get('current') === 'temperature_2m,relative_humidity_2m,wind_speed_10m') {
    const lat = Number(url.searchParams.get('latitude'));
    if (lat === -60) return new Response('', { status: 503 });
    const hot = lat === 34;
    return new Response(JSON.stringify({ current_units: { temperature_2m: '°C', relative_humidity_2m: '%', wind_speed_10m: 'km/h' },
      current: { time: new Date().toISOString(), temperature_2m: hot ? 34 : 8, relative_humidity_2m: hot ? 20 : 80, wind_speed_10m: hot ? 25 : 5 } }), { headers: { 'content-type': 'application/json' } });
  }
  return actualFetch(input, init);
};
const { server } = await import('../../server/api.mjs');
server.listen(Number(process.env.PORT || 8787));
