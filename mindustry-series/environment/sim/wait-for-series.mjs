const url = process.env.MINDUSTRY_HEALTH_URL ?? 'http://127.0.0.1:8080/health';
for (;;) {
  const response = await fetch(url);
  if (!response.ok) throw Error(`Series health returned ${response.status}`);
  if ((await response.json()).game_over === true) break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
