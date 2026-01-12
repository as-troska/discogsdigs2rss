# Discogs Digs RSS Feed

En enkel RSS feed generator som henter artikler fra Discogs Digs og gjør dem tilgjengelig som en RSS feed.

## Funksjoner

- Henter data fra https://www.discogs.com/digs
- Genererer RSS feed
- Lagrer data persistent i SQLite database
- Automatisk oppdatering hvert 30. minutt

## Installasjon

```bash
npm install
```

## Kjøring

```bash
npm start
```

Server vil starte på http://localhost:3000

RSS feeden er tilgjengelig på: http://localhost:3000/rss

## Miljøvariabler

- `PORT` - Port nummer (standard: 3000)
- `BASE_URL` - Base URL for RSS feed (valgfri)
