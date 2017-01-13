# About
MyAnimeList scanner

Scans MAL site for data need for recommedation engine "You Can (Not) Recomend".

For speed-up scans in parallel:

- Each scanner instance can perform several http requests at time (in queue).
- Several scanner instances can safely run together from many processes and PCs.
- Can use different "data providers" - parsing MAL site directly and with proxies, unofficial MAL API servers (see `mal_api_server`). See classes `MalDataProvider` -> `MalParser`, `MalApiClient`.

Safe parallelization is implemented with help of redis transactions (see class `MalBaseScanner`).

Scanned data is saved to PostgreSQL db (see `data/db-scheme.sql`, class `MalDataProcesser`).

# Using
Install PostgreSQL db scheme `data/db-scheme.sql`

Set options in `config/config-scanner.js`

Run `node index.js`

Add manually tasks to redis: `rpush mal.queuedTasks <task>`

See progress at cmd logs

#Tasks
List of tasks to grab only new data:

- `GenresOnce` - grab genres, once
- `Animes_New` - grab new animes
- `AnimesUserrecs_New` - grab users' anime-to-anime recommendations
- `UserLogins_New` - grab user id <-> login pairs
- `UserLists_New` - grab user lists, only for users with never checked yet list
- `UserProfiles_New` - grab user profile data, only for users with never checked yet profile

List of tasks to check udpates:

- `UserListsUpdated_Active` - check updates of active user lists, run frequently
- `UserListsUpdated_WithoutList` - check appearing of user lists, run rarely
- `UserListsUpdated_NonActive` - check updates of nonactive user lists, run rarely
- `UserLists_Updated` - grab updated user lists, after `UserListsUpdated_*`
- `AnimesUserrecs_All` - regrab users' anime-to-anime recommendations, run it rarely, like once in week..
- `UserProfiles_All` - just to update favs, run it very rarely!
- `Animes_All` - just to check possible updates of genres, relations, run it very rarely!

Special tasks to fix possible problems with logins swaps, will be added automatically:

- `SpUserLogins_Re`
- `UserProfiles_Re`

#Todo
Adding tasks from timer
