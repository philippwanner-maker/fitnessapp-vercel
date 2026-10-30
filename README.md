# SET Fitness-Tagebuch – Vercel

Dieses Verzeichnis ist die Vercel-kompatible Ausgabe der SET-App.

## Deployment

1. Den gesamten Inhalt dieses Ordners in ein GitHub-Repository hochladen.
2. Das Repository in Vercel importieren.
3. Über den Vercel Marketplace eine Upstash-Redis-Datenbank verbinden.
4. In Vercel unter **Settings → Environment Variables** die Variablen `UPSTASH_REDIS_REST_URL` und `UPSTASH_REDIS_REST_TOKEN` für Production, Preview und Development hinterlegen. Manche Vercel-Integrationen nennen diese Werte `KV_REST_API_URL` und `KV_REST_API_TOKEN`; beide Varianten werden unterstützt.
5. Neu deployen.

Ohne die beiden Upstash-Variablen funktionieren Training, Verlauf, Kalender und Fortschritt lokal im Browser. Die Online-Community benötigt die Datenbank.
