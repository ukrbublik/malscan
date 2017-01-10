/**
 * MAL data processer
 * Processes results from MAL data provider and saves to DB.
 *
 * @author ukrbublik
 */

const deepmerge = require('deepmerge');
const assert = require('assert');
const Helpers = require('../Helpers');
const _ = require('underscore')._;
const MalError = require('./MalError');
const pgEscape = require('pg-escape');
const redis = require("redis");
const fs = require('fs');


/**
 * 
 */
class MalDataProcesser {
  /**
   * @return array default options
   */
  static get DefaultOptions() {
    return {
      maxRating: 10,
    }
  }


  constructor() {
  }

  /**
   *
   */
  init(options = {}, dbConnection, redisConnection) {
    this.options = deepmerge.all([ cls.DefaultOptions, options ]);
    this.db = dbConnection;
    this.redis = redisConnection;

    //get enum values from db
    return Promise.all([
      this.db.manyOrNone("SELECT unnest(enum_range(NULL::malrec_item_type)) as v"),
      this.db.manyOrNone("SELECT unnest(enum_range(NULL::malrec_items_rel)) as v"),
    ]).then(([res1, res2]) => {
      this.itemTypes = [];
      if (res1)
        for (let row of res1)
          this.itemTypes.push(row.v);
      this.itemsRels = [];
      if (res2)
        for (let row of res2)
          this.itemsRels.push(row.v);
    });
  }

  /**
   *
   */
  isSafeToModilfyRatings() {
    //todo_later: true if not training (keep bool 'isTrainig?' in redis)
    return false;
  }


  /**
   *
   */
  processGenres(genres) {
    let promises = [];
    for (let id in genres) {
      promises.push(this.db.none("\
        insert into malrec_genres(id, name) \
        values ($(id), $(name)) \
        on conflict do nothing \
      ", {
        id: id,
        name: genres[id],
      }));
    }
    return Promise.all(promises);
  }


  /**
   *
   */
  processAnime(animeId, anime) {
    if (anime === null) {
      return this.db.query("\
        update malrec_items \
        set is_deleted = true \
        where id = $(animeId) \
      ", {
        animeId: animeId,
      });
    }

    let promises = [];
    anime.id = animeId;

    //add new anime type enum values
    if (anime.type && this.itemTypes.indexOf(anime.type) == -1) {
      promises.push(
        this.db.query("alter type malrec_item_type add value $(v)", { v: anime.type })
        .catch((err) => {
          if (err.code == 42710) {
            //already exists
          } else throw err;
        })
        .then(() => {
          this.itemTypes.push(anime.type);
        }));
    }
    if (Object.keys(anime.rels).length) {
      let allRelAnimesIds = Object.keys(anime.rels).map(Number);
      //Skip relations with type "Other", because they can mix completely different franchises
      //Example: https://myanimelist.net/anime/28149/Nihon_Animator_Mihonichi
      let frRelAnimesIds = Object.keys(anime.rels)
        .filter((id) => (anime.rels[id] != "Other")).map(Number);

      //add new relation type enum values
      let newRels = _.difference(allRelAnimesIds.map((fromId) => anime.rels[fromId])
        .filter((v) => v), this.itemsRels);
      for (let relName of newRels) {
        promises.push(
          this.db.query("alter type malrec_items_rel add value $(v)", { v: relName })
          .catch((err) => {
            if (err.code == 42710) {
              //already exists
            } else throw err;
          })
          .then(() => {
            this.itemsRels.push(relName);
          }));
      }
      
      //If there is already franchise_id in related animes, get it; otherwise create new one.
      //If there are no some related animes in db yet, create empty ones
      if (frRelAnimesIds.length) {
        promises.push(
          this.db.tx((t) => {
            return t.manyOrNone("\
              select id, franchise_id \
              from malrec_items \
              where id in(" + frRelAnimesIds.join(", ") + ") \
              for update \
            ").then((rows) => {
              let rowsWithFr = !rows ? [] : rows.filter(row => row.franchise_id);
              let frsCnts = {}, frsIds = {};
              for (let row of rowsWithFr) {
                if(frsCnts[row.franchise_id] === undefined) {
                  frsCnts[row.franchise_id] = 0;
                  frsIds[row.franchise_id] = [];
                }
                frsCnts[row.franchise_id]++;
                frsIds[row.franchise_id].push(parseInt(row.id));
              }
              let promise;
              if (rowsWithFr.length) {
                let frId = parseInt(Object.keys(frsCnts)
                  .reduce((prev, curr) => (frsCnts[curr] > frsCnts[prev] ? curr : prev)));
                if (Object.keys(frsCnts).length > 1) {
                  let otherFrIds = Object.keys(frsCnts).filter((id) => (id != frId)).map(Number);
                  console.log("Merging franchises " + Object.keys(frsCnts).join(', ') 
                    + " into " + frId);
                  promise = t.query("\
                    update malrec_items \
                    set franchise_id = $(frId) \
                    where franchise_id in (" + otherFrIds.join(', ') + ")", {
                      frId: frId
                  }).then(() => frId);
                } else {
                  promise = Promise.resolve(frId);
                }
              } else {
                promise = t.one("\
                  select nextval('malrec_items_franchise_id_seq'::regclass) as fr_id \
                ").then((row) => row.fr_id);
              }
              return promise.then((frId) => {
                anime.franchise_id = frId;
                let idsWoFr = !rows ? [] : rows.filter(row => !row.franchise_id).map(row => row.id);
                if (!idsWoFr.length)
                  promise = Promise.resolve();
                else
                  promise = t.query("\
                    update malrec_items \
                    set franchise_id = $(frId) \
                    where id in (" + idsWoFr.join(', ') + ") and franchise_id is null", {
                      frId: frId
                  });
                return promise.then(() => {
                  let alrIds = !rows ? [] : rows.map(row => row.id).map(Number);
                  let idsToIns = _.difference(frRelAnimesIds, alrIds);
                  if (!idsToIns.length)
                    promise = Promise.resolve();
                  else {
                    let iv = "";
                    for (let id of idsToIns)
                      iv += (iv ? ", " : "") + "(" + id + ", " + frId + ")";
                    promise = t.query("\
                      insert into malrec_items(id, franchise_id) \
                      values " + iv + " on conflict do nothing");
                  }
                  return promise;
                });
              });
            });
          })
        );
      }
    }

    return Promise.all(promises).then(() => {
      return this.db.tx((t) => {
        return Promise.all([
          t.oneOrNone("\
            select * \
            from malrec_items \
            where id = $(id) \
            for udpate \
          ", {
            id: animeId,
          }),
          t.manyOrNone("\
            select to_id, rel \
            from malrec_items_rels \
            where from_id = $(id) \
            for udpate \
          ", {
            id: animeId,
          })
        ]).then(([row1, rows2]) => {
          let batch = [];
          let oldAnime = row1;
          let oldRels = {};
          if (rows2)
            for (let row of rows2) {
              oldRels[row.to_id] = row.rel;
            }
          let newRels = anime.rels;
          let oldRelsIds = Object.keys(oldRels).map(Number);
          let newRelsIds = Object.keys(newRels).map(Number);

          //ins/upd anime
          let cols = ['id', 'name', 'type', 'genres', 'franchise_id'];
          let newAnime = _.pick(anime, cols);
          let params = {};
          let sql = "";
          if (!oldAnime) {
            cols = Object.keys(newAnime);
            params = newAnime;
            let vals = cols.map(c => '$('+c+')'+(c == 'genres' ? '::integer[]' : ''));
            sql = "insert into malrec_items(" + cols.join(", ") + ")" 
              + " values(" + vals.join(", ") + ")"
              + " on conflict do nothing";
          } else {
            cols = cols.filter((k) => (k == 'genres' 
              ? !Helpers.isSameElementsInArrays(newAnime[k], oldAnime[k]) 
              : newAnime[k] !== undefined && newAnime[k] != oldAnime[k]));

            if (cols.length) {
              params = _.pick(newAnime, cols);
              params.id = newAnime.id;
              sql = "update malrec_items set " 
                + cols.map(c => c+' = '+'$('+c+')'+(c == 'genres' ? '::integer[]' : '')).join(", ")
                + " where id = $(id)";
            }
          }
          if (sql != '')
            batch.push(t.query(sql, params));

          //add/del/upd rels
          let relsToUpd = _.pick(newRels, _.intersection(oldRelsIds, newRelsIds)
            .filter(id => oldRels[id] != newRels[id]));
          let relsIdsToDel = _.difference(oldRelsIds, newRelsIds);
          let relsToAdd = _.pick(newRels, _.difference(newRelsIds, oldRelsIds));
          if (relsIdsToDel.length || Object.keys(relsToAdd).length 
           || Object.keys(relsToUpd).length) {
            if (relsIdsToDel.length) {
              batch.push(t.query("\
                delete from malrec_items_rels \
                where from_id = $(from_id) and to_id in(" + relsIdsToDel.join(", ") + ")", {
                  from_id: animeId,
                }));
            }
            if (Object.keys(relsToAdd).length) {
              let iv = "";
              let params = {};
              params.from_id = animeId;
              for (let id in relsToAdd) {
                params['rel_'+id] = relsToAdd[id];
                iv += (iv ? ", " : "") + "($(from_id), " + id + ", $(rel_" + id + "))";
              }
              batch.push(t.query("\
                insert into malrec_items_rels(from_id, to_id, rel) \
                values " + iv + "\
                on conflict do nothing", 
              params));
            }
            if (Object.keys(relsToUpd).length) {
              for (let id in relsToUpd) {
                batch.push(t.query("\
                  update malrec_items_rels \
                  set rel = $(rel) \
                  where from_id = $(from_id) and to_id = $(to_id)", {
                    rel: relsToUpd[id],
                    from_id: animeId,
                    to_id: id,
                  }));
              }
            }
          }
          return t.batch(batch);
        });
      });
    });
  }


  /**
   *
   */
  processAnimeUserrecs(animeId, newRecs) {
    if (newRecs === null) {
      return this.db.query("\
        update malrec_items \
        set is_deleted = true \
        where id = $(animeId) \
      ", {
        animeId: animeId,
      });
    }

    return this.db.tx((t) => {
      return t.manyOrNone("\
        select to_id, weight \
        from malrec_items_recs \
        where from_id = $(id) \
        for update \
      ", {
        id: animeId,
      }).then((rows) => {
        let oldRecs = {};
        if (rows)
          for (let row of rows) {
            oldRecs[row.to_id] = row.weight;
          }
        let oldRecsIds = Object.keys(oldRecs).map(Number);
        let newRecsIds = Object.keys(newRecs).map(Number);

        //check new anime ids in recs for existence in db
        let promise;
        let newAnimeIds = _.difference(newRecsIds, oldRecsIds);
        if (!newAnimeIds.length)
          promise = Promise.resolve(null);
        else
          promise = t.manyOrNone("\
            select id \
            from malrec_items \
            where id in(" + newAnimeIds.join(", ") + ", " + animeId + ")"
          );
        return promise.then((rows) => {
          let batch = [];
          
          let alrAnimeIds = !rows ? [] : rows.map(row => row.id);
          let animeIdsToIns = _.difference(newAnimeIds, alrAnimeIds);
          if (animeIdsToIns.length) {
            let iv = "";
            for (let id of animeIdsToIns)
              iv += (iv ? ", " : "") + "(" + id + ")";
            batch.push(t.query("insert into malrec_items(id)"
             + " values " + iv 
             + " on conflict do nothing"));
          }

          //add/del/upd recs
          let recsToUpd = _.pick(newRecs, _.intersection(oldRecsIds, newRecsIds)
            .filter(id => oldRecs[id] != newRecs[id]));
          let recsIdsToDel = _.difference(oldRecsIds, newRecsIds);
          let recsToAdd = _.pick(newRecs, _.difference(newRecsIds, oldRecsIds));
          if (recsIdsToDel.length || Object.keys(recsToAdd).length 
           || Object.keys(recsToUpd).length) {
            if (recsIdsToDel.length) {
              batch.push(t.query("\
                delete from malrec_items_recs \
                where from_id = $(from_id) and to_id in(" + recsIdsToDel.join(", ") + ")", {
                  from_id: animeId,
                }));
            }
            if (Object.keys(recsToAdd).length) {
              let iv = "";
              let params = {};
              params.from_id = animeId;
              for (let id in recsToAdd) {
                params['rel_'+id] = recsToAdd[id];
                iv += (iv ? ", " : "") + "($(from_id), " + id + ", $(rel_" + id + "))";
              }
              batch.push(t.query("\
                insert into malrec_items_recs(from_id, to_id, weight) \
                values " + iv + "\
                on conflict do nothing",
              params));
            }
            if (Object.keys(recsToUpd).length) {
              for (let id in recsToUpd) {
                batch.push(t.query("\
                  update malrec_items_recs \
                  set weight = $(weight) \
                  where from_id = $(from_id) and to_id = $(to_id)", {
                    weight: recsToUpd[id],
                    from_id: animeId,
                    to_id: id,
                  }));
              }
            }
            batch.push(t.query("\
              update malrec_items \
              set recs_update_ts = now(), recs_check_ts = now() \
              where id = $(id) \
            ", {
              id: animeId,
            }));
          } else {
            batch.push(t.query("\
              update malrec_items \
              set recs_check_ts = now() \
              where id = $(id) \
            ", {
              id: animeId,
            }));
          }
          return t.batch(batch);
        });
      });
    });
  }


  /**
   *
   */
  processUserIdToLogin(userId, userLogin) {
    if (userLogin === null) {
      this.redis.srem("mal.recheckUserIds", userId);
      return this.db.query("\
        update malrec_users \
        set is_deleted = true \
        where id = $(userId) \
      ", {
        userId: userId,
      });
    }

    assert(userId > 0);
    //assert(typeof userLogin == 'string' && userLogin.length > 0);

    return this.db.tx((t) => {
      return this._handleUserDuplicatesTx(t, userId, userLogin);
    });
  }

  /**
   * Sometimes (rarely, but can happen on MAL) user logins are changed or swapped, 
   *  which cause some complications (because user's anime lists can be get by login, not id).
   * This method fixes possible mess.
   * @param t - pgsql transaction connection
   * @param userId - fetched user id
   * @param userLogin - fetched user login
   */
  _handleUserDuplicatesTx(t, userId, userLogin) {
    return t.manyOrNone("\
      select id, login \
      from malrec_users \
      where id = $(id) or login = $(login) \
      for update \
    ", {
      id: userId,
      login: userLogin,
    }).then((rows) => {
      if (!rows.length) {
        return t.query("\
          insert into malrec_users(id, login) \
          values ($(id), $(login)) \
        ", {
          id: userId,
          login: userLogin,
        });
      } else {
        let alreadyUserByLogin = rows.filter((row) => (row.login == userLogin));
        let alreadyUserById = rows.filter((row) => (row.id == userId));
        alreadyUserByLogin = alreadyUserByLogin.length ? alreadyUserByLogin[0] : null;
        alreadyUserById = alreadyUserById.length ? alreadyUserById[0] : null;
        if (alreadyUserById && alreadyUserById.login != userLogin) {
          //Login changed. It happens rarely, but can happen
          let batch = [];
          if (alreadyUserByLogin) {
            //Logins swap. Can happen!
            console.warn("Logins swap for #"+userId+" : " 
              + alreadyUserById.login + " -> " + userLogin+". " + 
              "#"+alreadyUserByLogin.id+" already had login "+userLogin 
              + ", need to recheck that id and old login");
            batch.push(t.query("\
              update malrec_users \
              set login = $(tempDummyLogin), need_to_check_list = true \
              where id = $(id) \
            ", {
              id: alreadyUserByLogin.id,
              tempDummyLogin: '?????_'+userLogin+'_'+new Date().getTime(),
            }));
            if (alreadyUserByLogin.id > 0) {
              this.redis.sadd("mal.recheckUserIds", alreadyUserByLogin.id);
            } else {
              batch.push(t.query("\
                update malrec_users \
                set is_deleted = true \
                where id = $(id) \
              ", {
                id: alreadyUserByLogin.id,
              }));
            }
          } else {
            console.warn("Login change for #"+userId+" : "
              + alreadyUserById.login + " -> " + userLogin + ", need to recheck old login");
          }
          batch.push(t.query("\
            update malrec_users \
            set login = $(login), need_to_check_list = true \
            where id = $(id) \
          ", {
            id: userId,
            login: userLogin,
          }));
          if (alreadyUserById.login.indexOf('?????_') == -1)
            this.redis.sadd("mal.recheckUserLogins", alreadyUserById.login);
          return t.batch(batch);
        } else if(alreadyUserByLogin && alreadyUserByLogin.id != userId 
         && alreadyUserByLogin.id > 0) {
          //Previous id was temp => just update it to real one
          return t.query("\
            update malrec_users \
            set id = $(id) \
            where login = $(login) \
          ", {
            id: userId,
            login: userLogin,
          });
        } else if(alreadyUserByLogin && alreadyUserByLogin.id != userId) {
          //Logins swap
          console.warn("Logins swap for #"+userId+" "+userLogin+" : " + 
            "#"+alreadyUserByLogin.id+" already had login "+userLogin+", need to recheck that id");
          this.redis.sadd("mal.recheckUserIds", alreadyUserByLogin.id);
          let pr1 = t.query("\
            update malrec_users \
            set login = $(tempDummyLogin), need_to_check_list = true \
            where id = $(id) \
          ", {
            id: alreadyUserByLogin.id,
            tempDummyLogin: '?????_'+userLogin+'_'+new Date().getTime(),
          });
          let pr2 = t.query("\
            insert into malrec_users(id, login) \
            values ($(id), $(login)) \
          ", {
            id: userId,
            login: userLogin,
          });
          return t.batch([pr1, pr2]);
        }
      }
    }).then(() => {
      this.redis.srem("mal.recheckUserIds", userId);
      this.redis.srem("mal.recheckUserLogins", userLogin);
    });
  }

  /**
   *
   */
  processProfile(userId, userLogin, user) {
    if (user === null) {
      this.redis.srem("mal.recheckUserLogins", userLogin);
      return this.db.query("\
        update malrec_users \
        set is_deleted = true \
        where login = $(userLogin) \
      ", {
        userLogin: userLogin,
      });
    }

    let isUserIdChanged = (user.id && user.id != userId);
    let newUserId = (isUserIdChanged ? user.id : userId);
    assert(newUserId !== null);

    return this.db.tx((t) => {
      return this._handleUserDuplicatesTx(t, newUserId, userLogin).then(() => {
        return t.oneOrNone("\
          select * \
          from malrec_users \
          where id = $(newUserId) \
          for update \
        ", {
          newUserId: newUserId,
        }).then((oldUser) => {
          let newUser = {
            id: newUserId,
            login: user.login,
            gender: user.gender,
            reg_date: user.joinedDate,
            fav_items: user.favs,
          };
          let vals = {}, cols = Object.keys(newUser);
          let sql = "";
          if (!oldUser) {
            vals = newUser;
            sql = "insert into malrec_users(" + cols.join(", ") + ")" 
              + " values(" + cols.map((k) => '$('+k+')').join(", ") + ")";
          } else {
            assert(newUser.login == oldUser.login);
            cols = cols.filter((k) => (k == 'fav_items' 
              ? !Helpers.isSameElementsInArrays(newUser[k], oldUser[k])
              : newUser[k] !== undefined && newUser[k] != oldUser[k]));

            if (cols.length > 0) {
              vals = _.pick(newUser, cols);
              vals.id = newUserId;
              sql = "update malrec_users" 
                + " set " + cols.map((k) => k+'='+'$('+k+')').join(", ")
                + " where id = $(id)";
            }
          }
          return (sql != '' ? t.query(sql, vals) : Promise.resolve()).then(() => {
            /*if (cols.indexOf('fav_items') != -1)
              //update most_rated_items
              return t.func("malrec_update_user_most_rated_items", 
                [newUserId, this.options.maxRating]);*/
          });
        });
      });
    });
  }

  /**
   *
   */
  processUserListUpdated(userId, userLogin, listUpdatedTs, updatedRes) {
    if (updatedRes === null) {
      return this.db.query("\
        update malrec_users \
        set is_deleted = true \
        where login = $(userLogin) \
      ", {
        userLogin: userLogin,
      });
    }
    
    let newUpdatedDate = updatedRes.listUpdateDate;
    if (newUpdatedDate !== null && newUpdatedDate > listUpdatedTs) {
      return this.db.query("\
        update malrec_users \
        set need_to_check_list = true \
        where login = $(userLogin) \
      ", {
        userLogin: userLogin,
      });
    } else return Promise.resolve();
  }

  /**
   *
   */
  processUserList(userId, userLogin, _listId, newList) {
    if (newList === null) {
      return this.db.query("\
        update malrec_users \
        set is_deleted = true \
        where login = $(userLogin) \
      ", {
        userLogin: userLogin,
      });
    }
    let isUserIdChanged = (newList.userId && newList.userId != userId);
    let newUserId = (isUserIdChanged ? newList.userId : userId);

    return this.db.tx((t) => {
      return this._handleUserDuplicatesTx(t, newUserId, userLogin).then(() => {
        // Get old list
        return Promise.all([
          t.manyOrNone("\
            select item_id, rating \
            from malrec_ratings \
            where user_list_id = \
              (select list_id from malrec_users where id = $(userId)) \
          ", {
            userId: userId,
          }),
          t.one("\
            select unrated_items, list_update_ts, list_check_ts, list_id \
            from malrec_users \
            where id = $(userId) \
          ", {
            userId: userId
          }),
        ]).then(([rows1, row2]) => {
          if (!row2)
            throw new Error("User #"+userId + " "+userLogin + " not found in db");
          let listId = row2.list_id;
          let oldList = { 
            userId: userId,
            ratings: {}, 
            unratedAnimeIdsInList: [], 
            listUpdatedTs: row2.list_update_ts,
            listCheckedTs: row2.list_check_ts,
          };
          if (rows1)
            for (let row of rows1) {
              oldList.ratings[row.item_id] = row.rating;
            }
          oldList.unratedAnimeIdsInList = row2.unrated_items ? row2.unrated_items : [];

          let hadList = oldList && Object.keys(oldList.ratings).length > 0;
          let hasList = newList && Object.keys(newList.ratings).length > 0;
          let oldListAnimeIds = oldList ? Object.keys(oldList.ratings).map(Number) : [];
          let newListAnimeIds = newList ? Object.keys(newList.ratings).map(Number) : [];

          let promGetList;
          if (!listId && hasList) {
            promGetList = t.query("\
              update malrec_users \
              set list_id = nextval('malrec_users_list_id_seq'::regclass) \
              where id = $(id) and list_id is null \
            ", {
              id: newUserId,
            }).then(() => t.one("\
              select list_id \
              from malrec_users \
              where id = $(id) \
            ", {
              id: newUserId,
            })).then((row) => {
              listId = row.list_id;
              return listId;
            });
          } else {
            promGetList = Promise.resolve(listId);
          }
          return promGetList.then(() => {
            if (hasList)
              assert(!!listId);

            //get changes
            let unratedListChanged = !Helpers.isSameElementsInArrays(
              oldList.unratedAnimeIdsInList, newList.unratedAnimeIdsInList);
            let ratsToUpd = _.pick(newList.ratings, 
              _.intersection(oldListAnimeIds, newListAnimeIds)
              .filter(id => oldList.ratings[id] != newList.ratings[id]));
            let ratsIdsToDel = _.difference(oldListAnimeIds, newListAnimeIds);
            let ratsToAdd = _.pick(newList.ratings, 
              _.difference(newListAnimeIds, oldListAnimeIds));
            let affectedAnimeIds = Object.keys(ratsToAdd).map(Number)
              .concat(Object.keys(ratsToUpd).map(Number), ratsIdsToDel);

            //check new anime ids in list for existence in db
            let newAnimeIds = _.difference(newListAnimeIds, oldListAnimeIds).map(Number);
            let promGetItemIds = Promise.resolve(null);
            if (newAnimeIds.length)
              promGetItemIds = t.manyOrNone("\
                select id \
                from malrec_items \
                where id in(" + newAnimeIds.join(", ") + ")"
              );
            return promGetItemIds.then((rows) => {
              let batch = [];
              if (unratedListChanged || ratsIdsToDel.length || Object.keys(ratsToAdd).length
               || Object.keys(ratsToUpd).length) {
                //add/del/upd ratings
                let alrAnimeIds = !rows ? [] : rows.map(row => parseInt(row.id));
                let animeIdsToIns = _.difference(newAnimeIds, alrAnimeIds);
                if (animeIdsToIns.length) {
                  let iv = "";
                  for (let id of animeIdsToIns)
                    iv += (iv ? ", " : "") + "(" + id + ")";
                  batch.push(t.query("insert into malrec_items(id)"
                    + " values " + iv
                    + " on conflict do nothing"));
                }

                if (unratedListChanged) {
                  batch.push(t.query("\
                    update malrec_users \
                    set unrated_items = $(unrated_items)::integer[] \
                    where id = $(id) \
                  ", {
                    id: newUserId,
                    unrated_items: newList.unratedAnimeIdsInList,
                  }));
                }
                if (ratsIdsToDel.length) {
                  batch.push(t.query("\
                    update malrec_ratings \
                    set " + (this.isSafeToModilfyRatings() ? "rating" : "new_rating") + " = 0 \
                    where user_list_id = $(listId) \
                     and item_id in(" + ratsIdsToDel.join(", ") + ")", {
                      listId: listId,
                    }));
                }
                if (Object.keys(ratsToAdd).length) {
                  let iv = "";
                  let params = {};
                  params.listId = listId;
                  for (let id in ratsToAdd) {
                    params['rat_'+id] = ratsToAdd[id];
                    iv += (iv ? ", " : "") + "($(listId), " + id + ", $(rat_" + id + "), " 
                      + (this.isSafeToModilfyRatings() ? "false" : "true") + ")";
                  }
                  batch.push(t.query("\
                    insert into malrec_ratings(user_list_id, item_id, rating, is_new) \
                    values " + iv, params));
                }
                if (Object.keys(ratsToUpd).length) {
                  for (let id in ratsToUpd) {
                    batch.push(t.query("\
                      update malrec_ratings \
                      set " + (!this.isSafeToModilfyRatings() ? "rating" : "new_rating") 
                      + " = $(rating) \
                      where user_list_id = $(listId) and item_id = $(item_id)", {
                        rating: ratsToUpd[id],
                        listId: listId,
                        item_id: id,
                      }));
                  }
                }
                if (ratsIdsToDel.length || Object.keys(ratsToAdd).length 
                  || Object.keys(ratsToUpd).length) {
                  batch.push(t.query("\
                    update malrec_users \
                    set list_update_ts = $(list_update_ts), are_ratings_modified = true \
                    where id = $(id) \
                  ", {
                    id: newUserId,
                    list_update_ts: newList.listUpdatedTs,
                  }));

                  batch.push(t.func("malrec_update_user_most_rated_items", 
                    [newUserId, this.options.maxRating]));

                  if (affectedAnimeIds) {
                    batch.push(t.query("\
                      update malrec_items \
                      set are_ratings_modified = true \
                      where id in(" + affectedAnimeIds.join(", ") + ")" 
                      + " and are_ratings_modified = false \
                    "));
                  }
                }
              }
              batch.push(t.query("\
                update malrec_users \
                set list_check_ts = now(), need_to_check_list = false \
                where id = $(id) \
              ", {
                id: newUserId,
              }));

              return t.batch(batch);
            });
          });
        });
      });
    });


  }

}
var cls = MalDataProcesser; //for using "cls.A" as like "self::A" inside class

module.exports = MalDataProcesser;

