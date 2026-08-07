module.exports = function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  const url = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) return response.status(503).json({ error: 'Configuração do Supabase ausente.' });
  return response.status(200).json({ url, publishableKey });
};
