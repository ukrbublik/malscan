# About
MyAnimeList scanner

Scans MAL site for data need for recommedation engine "You Can (Not) Recomend".
For speed-up scans in parallel: 
- can use proxies as MAL mirrors
- can use separate unofficial MAL API servers (see mal_api_server)
- performs >1 requests at time for each source
Safe parallelization is implemented with help of redis transactions.
Scanned data is saved to PostgreSQL db (see data/db-scheme.sql)