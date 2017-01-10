/**
 * MAL scanner
 * Grabs animes, users, anime lists to db.
 *
 * @author ukrbublik
 */


const deepmerge = require('deepmerge');
const assert = require('assert');
const _ = require('underscore')._;
const ProgressBar = require('progress');
const MalParser = require('./MalParser');
const MalError = require('./MalError');
const MalBaseScanner = require('./MalBaseScanner');
const Helpers = require('../Helpers');
const shuffle = require('knuth-shuffle').knuthShuffle;


/**
 * 
 */
class MalScanner extends MalBaseScanner {
  /**
   * @return array default options
   */
  static get DefaultOptions() {
    return {
      scanner: {
        approxBiggestUserId: 5910700, //manually biggest found user id
        maxNotFoundUserIdsToStop: 300,
        //maxNotFoundAnimeIdsToStop: 100,
        cntErrorsToStopGrab: 20,
        saveProcessingIdsAfterEvery: 50,
        log: true,
      },
      processer: {
      },
    }
  }

  constructor() {
    super();
  }

  /**
   *
   */
  init(config, options = {}, dbConnection = null) {
    config = deepmerge.all([ cls.DefaultOptions, config ]);
    return super.init(config, options, dbConnection).then(() => {
    });
  }

  /**
   *
   */
  checkDbConnection() {
    return this.db.proc('version');
  }


  /**
   * <task> => [<func>, <params>]
   */
  static get allTasksFuncs() {
    return {
      GenresOnce: ['grabGenresOnce'],
      NewAnimes: ['grabNewAnimes'],
      AnimesUserrecs_New: ['grabAnimesUserrecs', 'New'],
      AnimesUserrecs_All: ['grabAnimesUserrecs', 'All'],
      UserLogins_New: ['grabNewUserLogins', 'New'],
      UserProfiles_New: ['grabUserProfiles', 'New'],
      UserProfiles_All: ['grabUserProfiles', 'All'],
      UserProfiles_Re: ['recheckUserProfiles'],
      UserLists_New: ['grabUserLists', 'New'],
      UserLists_All: ['grabUserLists', 'All'],
      UserLists_Updated: ['grabUserLists', 'Updated'],
      UserListsUpdated_All: ['grabUserListsUpdated', 'All'],
      UserListsUpdated_WithList: ['grabUserListsUpdated', 'WithList'],
      UserListsUpdated_WithoutList: ['grabUserListsUpdated', 'WithoutList'],
      UserListsUpdated_Active: ['grabUserListsUpdated', 'Active'],
      UserListsUpdated_NonActive: ['grabUserListsUpdated', 'NonActive'],
      test1: ['grabTest'],
      SpUserLogins_Lost: ['grabUserLoginsByList', 'Lost'], //obsolete
      SpUserLogins_Re: ['grabUserLoginsByList', 'Re'],
    };
  }

  /**
   * List of tasks to grab only data for new animes and new users
   */
  static get grabNewsTasksKeys() {
    return [
      'GenresOnce',
      'NewAnimes',
      'AnimesUserrecs_New',
      'UserLogins_New',
      'UserLists_New',
      'UserProfiles_New',
      'SpUserLogins_Re',
      'UserProfiles_Re',
    ];
  }

  /**
   * List of tasks to regrab data to check udpates
   */
  static get grabUpdatesTasksKeys() {
    return [
      //'UserLists_All', //too slow, better UserListsUpdated_* + UserLists_Updated
      //'UserListsUpdated_WithList', //also slow, better to split users on active and non-active
      'UserListsUpdated_Active', //run frequently
      'UserListsUpdated_WithoutList', //run rarely
      'UserListsUpdated_NonActive', //run rarely
      'UserLists_Updated', //after 'UserListsUpdated_*'
      
      'AnimesUserrecs_All', //run it rarely, like once in week..

      'UserProfiles_All', //just to update favs; run it very rarely!

    ];
  }

  /**
   *
   */
  doGrabTask(taskKey, taskData) {
    let funcAndParams = cls.allTasksFuncs[taskKey];
    if (funcAndParams === undefined)
      throw new Error("Unknown task " + taskKey);
    let func = funcAndParams[0];
    let params = funcAndParams.splice(1);
    return this[func](taskData, ...params);
  }

  /**
   *
   */
  static shouldSkipTask(taskKey) {
    if (taskKey == 'GenresOnce') {
      //Skip if already grabbed
      return this.db.one("\
        select coalesce(count(id), 0) as cnt \
        from malrec_genres \
      ").then((row) => {
        return (row.cnt > 0);
      });
    } else {
      return Promise.resolve(false);
    }
  }

  /**
   * Before running task with 1+ concurrent scanners, do once some preparations,
   *  like getting cnt of total ids, list of ids
   * @param anyScanner any of 1+ concurrent scanners, we need just its provider & redis
   */
  static beforeTask(taskKey, anyScanner) {
    if (taskKey == 'NewAnimes') {
      return Promise.all([
        anyScanner.provider.getApproxMaxAnimeId({}),
        anyScanner.redis.getAsync("mal.maxGrabbedAnimeId")
      ]).then(([approxMaxAnimeId, maxGrabbedAnimeId]) => {
        maxGrabbedAnimeId = maxGrabbedAnimeId ? parseInt(maxGrabbedAnimeId) : 0;
        approxMaxAnimeId = Math.max(maxGrabbedAnimeId, approxMaxAnimeId);
        let totalIdsCnt = (approxMaxAnimeId - maxGrabbedAnimeId);
        /*let listOfIds = (Array.from({length: approxMaxAnimeId}, 
          (v, k) => maxGrabbedAnimeId + 1 + k));*/
        return {
          maxGrabbedAnimeId,
          approxMaxAnimeId,
          totalIdsCnt,
        };
      });
    } else if (taskKey.indexOf('AnimesUserrecs_') == 0) {
      let mode = taskKey.substring('AnimesUserrecs_'.length);
      let cond = '1=1';
      if (mode == 'New')
        cond = "recs_check_ts is null";

      return Promise.all([
        //totalIdsCnt
        anyScanner.db.one("\
          select count(*) as cnt \
          from malrec_items \
          where " + cond + "\
        ").then((row) => row.cnt),
        /*
        //listOfIds
        anyScanner.db.manyOrNone("\
          select id \
          from malrec_items \
          where " + cond + "\
          order by " + (onlyNew ? "id asc" : "recs_update_ts desc") + " \
        ", {
        }).then((rows) => {
          return !rows ? [] : (rows.map((row) => parseInt(row.id)));
        }), */
      ]).then(([totalIdsCnt]) => {
        return {
          totalIdsCnt,
        };
      });
    } else if (taskKey.indexOf('UserLogins_') == 0) {
      let mode = taskKey.substring('UserLogins_'.length);
      return anyScanner.redis.getAsync("mal.maxGrabbedUserId").then((maxGrabbedUserId) => {
        maxGrabbedUserId = parseInt(maxGrabbedUserId);
        let totalIdsCnt, approxMaxId;
        if (maxGrabbedUserId == 0) {
          //first grab
          approxMaxId = anyScanner.options.scanner.approxBiggestUserId;
          totalIdsCnt = (approxMaxId - maxGrabbedUserId);
        } else {
          //not first grab
          approxMaxId = maxGrabbedUserId;
          totalIdsCnt = 0; //unknown max
        }
        return {
          approxMaxId,
          maxGrabbedUserId,
          totalIdsCnt,
        };
      });
    } else if (taskKey.indexOf('SpUserLogins_') == 0) {
      let mode = taskKey.substring('SpUserLogins_'.length);
      if (mode == 'Lost') {
        //find "holes"-ids
        return Promise.all([
          anyScanner.redis.getAsync("mal.maxGrabbedUserId"),
          anyScanner.db.manyOrNone("\
            select id \
            from malrec_users \
            where 1=1 \
            order by id asc \
          ", {
          }).then((rows) => {
            return (!rows ? [] : rows);
          }),
        ]).then(([maxGrabbedUserId, alreadyRows]) => {
          maxGrabbedUserId = parseInt(maxGrabbedUserId);
          assert(maxGrabbedUserId > 0);
          let alreadyIds = {};
          for (let row of alreadyRows)
            alreadyIds[row.id] = 1;
          let listOfIds = [];
          for (let id = 1 ; id < maxGrabbedUserId ; id++) {
            if (!alreadyIds[id])
              listOfIds.push(id);
          }
          let totalIdsCnt = listOfIds.length;
          return {
            listOfIds,
            totalIdsCnt,
          };
        });
      } else if (mode == 'Re') {
        //find ids in "mal.recheckUserIds"
        return anyScanner.redis.smembersAsync("mal.recheckUserIds").then((userIds) => {
          let listOfIds = !userIds ? [] : userIds.map(Number);
          let totalIdsCnt = listOfIds.length;
          return {
            listOfIds,
            totalIdsCnt,
          };
        });
      }
    } else if (taskKey == 'UserProfiles_Re') {
      //find logins in "mal.recheckUserLogins"
      return anyScanner.redis.smembersAsync("mal.recheckUserLogins").then((userLogins) => {
        let listOfData = !userLogins ? [] : userLogins;
        let listOfIds = Array.from({length: listOfData.length}, (v, k) => 0 + k);
        let totalIdsCnt = listOfIds.length;
        return {
          listOfIds,
          totalIdsCnt,
          listOfData
        };
      });
    } else if (taskKey.indexOf('UserProfiles_') == 0) {
      let mode = taskKey.substring('UserProfiles_'.length);
      let cond = '1=1';
      if (mode == 'New')
        cond = "reg_date is null";

        return Promise.all([
          //totalIdsCnt
          anyScanner.db.one("\
            select count(*) as cnt \
            from malrec_users \
            where " + cond + "\
          ").then((row) => row.cnt),
          /*
          //listOfIds
          anyScanner.db.manyOrNone("\
            select id \
            from malrec_users \" + cond + "
            where " + cond + "\
            order by id asc \
          ", {
          }).then((rows) => {
            return !rows ? [] : (rows.map((row) => row.id));
          }), */
        ]).then(([totalIdsCnt]) => {
          return {
            totalIdsCnt,
          };
        });
    } else if (taskKey.indexOf('UserListsUpdated_') == 0) {
      let mode = taskKey.substring('UserListsUpdated_'.length);
      let cond = "1=1";
      if (mode == 'WithList')
        cond = "list_update_ts is not null";
      else if (mode == 'WithoutList')
        cond = "list_update_ts is null";
      else if (mode == 'Active')
        cond = "list_update_ts > ('now'::timestamp - '1 year'::interval)";
      else if (mode == 'NonActive')
        cond = "list_update_ts < ('now'::timestamp - '1 year'::interval)";

      return Promise.all([
        //totalIdsCnt
        anyScanner.db.one("\
          select count(*) as cnt \
          from malrec_users \
          where need_to_check_list = false \
            and "+ cond +" \
        ").then((row) => row.cnt),
        /*
        //listOfIds
        anyScanner.db.manyOrNone("\
          select id \
          from malrec_users \
          where id >= $(nextId) \
            and need_to_check_list = false and "+ cond +" \
          order by id asc \
        ", {
        }).then((rows) => {
          let ids = !rows ? [] : rows.map((row) => parseInt(row.id));
          return ids;
        }), */
      ]).then(([totalIdsCnt]) => {
        return {
          totalIdsCnt,
        };
      });
    } else if (taskKey.indexOf('UserLists_') == 0) {
      let mode = taskKey.substring('UserLists_'.length);
      let cond = '1=1';
      if (mode == 'New')
        cond = "list_check_ts is null";
      else if (mode == 'Updated')
        cond = "need_to_check_list = true";

      return Promise.all([
        //totalIdsCnt
        anyScanner.db.one("\
          select count(*) as cnt \
          from malrec_users \
          where "+ cond +"\
        ").then((row) => row.cnt),
        /*
        //listOfIds
        anyScanner.db.manyOrNone("\
          select id \
          from malrec_users \
          where "+ cond +"\
          order by id asc \
        ", {
        }).then((rows) => {
          let ids = !rows ? [] : rows.map((row) => parseInt(row.id));
          return ids;
        }), */
      ]).then(([totalIdsCnt]) => {
        return {
          totalIdsCnt,
        };
      });
    } else if (taskKey == 'test1') {
      let totalIdsCnt = 1000;
      let listOfIds = Array.from({length: 1000}, (v, k) => 1 + k);
      return Promise.resolve({
        totalIdsCnt,
        listOfIds,
      });
    } else {
      return Promise.resolve();
    }
  }

  /**
   *
   */
  static afterTask(taskKey, taskSuccessed, redis) {
    if (cls.sharedListsOfIds && cls.sharedListsOfIds[taskKey])
      delete cls.sharedListsOfIds[taskKey];
    return Promise.resolve().then(() => {
    });
  }

  /**
   *
   */
  grabTest(data) {
    return this.grabByIds({
      key: 'test1',
      trackBiggestId: false,
      //maxNotFoundIdsToStop: 12,
      approxMaxId: 1000,
      getTotalIdsCnt: () => data.totalIdsCnt,
      getListOfIds: () => data.listOfIds,
      isByListOfIds: true,
      getNextIds: (nextId, limit) => {
        let ids = Array.from({length: Math.min(limit, 1000 - nextId + 1)}, 
          (v, k) => nextId + k);
        return { ids: ids };
      },
      getDataForIds: (ids) => null,
      fetch: (id) => {
        return this.provider.queue.add(() => new Promise((resolve, reject) => {
          setTimeout(() => {
            if (Math.random() < 0.3)
              reject("random err");
            //if (id >= 2000)
            //  resolve(null);
            resolve({id: id});
          }, Helpers.getRandomInt(20,200));
        }));
      },
      process: (id, obj) => { return Promise.resolve(); },
    });
  }

  /**
   *
   */
  grabGenresOnce(data) {
    let key = 'GenresOnce';
    return this.provider.getGenres().then((genres) => {
      return this.processer.processGenres(genres);
    }).then(() => {
      return {};
    });
  }


  /**
   * 
   */
  grabNewAnimes(data) {
    let key = 'NewAnimes';
    return this.grabByIds({
      key: key,
      startFromId: data.maxGrabbedAnimeId + 1,
      approxMaxId: data.approxMaxAnimeId,
      getNextIds: (nextId, limit) => {
        let ids = Array.from({length: Math.min(limit, data.approxMaxAnimeId - nextId + 1)}, 
          (v, k) => nextId + k);
        return { ids: ids };
      },
      getTotalIdsCnt: () => data.totalIdsCnt,
      getDataForIds: (ids) => null,
      fetch: (id) => this.provider.getAnimeInfo({animeId: id}),
      process: (id, obj) => this.processer.processAnime(id, obj),
    }).then((res) => {
      this.redis.set("mal.maxGrabbedAnimeId", data.approxMaxAnimeId);
      return res;
    });
  }


  /**
   * mode - 'New' only for animes with never checked yet userrecs, 'All'
   */
  grabAnimesUserrecs(data, mode = 'All') {
    let key = 'AnimesUserrecs_'+mode;
    let cond = '1=1';
    if (mode == 'New')
      cond = "recs_check_ts is null";
    return this.grabByIds({
      key: key,
      getNextIds: (nextId, limit) => {
        return this.db.manyOrNone("\
          select id \
          from malrec_items \
          where id >= $(nextId) \
           and " + cond + "\
          order by id asc \
          limit $(limit) \
        ", {
          nextId: nextId,
          limit: limit,
        }).then((rows) => {
          return {ids: !rows ? [] : rows.map((row) => parseInt(row.id)) };
        });
      },
      getTotalIdsCnt: () => data.totalIdsCnt,
      getDataForIds: (ids) => null,
      fetch: (id) => this.provider.getAnimeUserrecs({animeId: id}),
      process: (id, obj) => this.processer.processAnimeUserrecs(id, obj),
    });
  }

  /**
   *
   */
  grabNewUserLogins(data, mode = 'New') {
    let key = 'UserLogins_' + mode;
    if (data.maxGrabbedUserId == 0) {
      //first grab
      return this.grabByIds({
        key: key,
        startFromId: data.maxGrabbedUserId + 1,
        approxMaxId: data.approxMaxId,
        getNextIds: (nextId, limit) => { 
          let ids = Array.from({
            length: Math.min(limit, data.approxMaxId - nextId + 1)
          }, (v, k) => nextId + k);
          return { ids: ids };
        },
        getTotalIdsCnt: () => data.totalIdsCnt,
        getDataForIds: (ids) => null,
        fetch: (id) => this.provider.userIdToLogin({userId: id}),
        process: (id, obj) => this.processer.processUserIdToLogin(id, obj),
      }).then((res) => {
        let newMaxGrabbedUserId = data.approxMaxId;
        this.redis.set("mal.maxGrabbedUserId", newMaxGrabbedUserId);
        return res;
      });
    } else {
      //not first grab
      return this.grabByIds({
        key: key,
        trackBiggestId: true,
        startFromId: data.maxGrabbedUserId + 1,
        approxMaxId: data.approxMaxId,
        maxNotFoundIdsToStop: this.options.scanner.maxNotFoundUserIdsToStop,
        getTotalIdsCnt: () => data.totalIdsCnt,
        getDataForIds: (ids) => null,
        fetch: (id) => this.provider.userIdToLogin({userId: id}),
        process: (id, obj) => this.processer.processUserIdToLogin(id, obj),
      }).then((res) => {
        if (res.biggestFoundId) {
          let newMaxGrabbedUserId = res.biggestFoundId;
          this.redis.set("mal.maxGrabbedUserId", newMaxGrabbedUserId);
        }
        if (res.cntNotFoundIdsAfterBiggest < this.options.scanner.maxNotFoundUserIdsToStop)
          res.retry = true;
        return res;
      });
    }
  }

  /**
   * mode - 'Lost' to check user logins by "holes"-ids, 
   *  "Re" - regrab user logins with ids in redis' set "mal.recheckUserIds"
   */
  grabUserLoginsByList(data, mode = 'Lost') {
    let key = 'SpUserLogins_' + mode;
    return this.grabByIds({
      key: key,
      isByListOfIds: true,
      getTotalIdsCnt: () => data.totalIdsCnt,
      getListOfIds: () => data.listOfIds,
      getDataForIds: (ids) => null,
      fetch: (id) => this.provider.userIdToLogin({userId: id}),
      process: (id, obj) => this.processer.processUserIdToLogin(id, obj),
    });
  }

  /**
   * mode - 'New' only for users with missing profile data, 'All'
   */
  grabUserProfiles(data, mode = 'New') {
    let key = 'UserProfiles_' + mode;
    let cond = '1=1';
    if (mode == 'New')
      cond = "reg_date is null";
    else if (mode == 'All')
      cond = "is_deleted = false";
    return this.grabByIds({
      key: key,
      getNextIds: (nextId, limit) => {
        return this.db.manyOrNone("\
          select id, login \
          from malrec_users \
          where id >= $(nextId) \
           and " + cond + "\
          order by id asc \
          limit $(limit) \
        ", {
          nextId: nextId,
          limit: limit,
        }).then((rows) => {
          let ids = [], logins = {};
          if (rows)
            for (let row of rows) {
              ids.push(parseInt(row.id));
              logins[row.id] = row.login;
            }
          return {ids: ids, data: logins};
        });
      },
      getTotalIdsCnt: () => data.totalIdsCnt,
      getDataForIds: (ids) => {
        return this.db.manyOrNone("\
          select id, login \
          from malrec_users \
          where id in (" + ids.join(', ') + ") \
        ").then((rows) => {
          let logins = {};
          if (rows)
            for (let row of rows) {
              logins[row.id] = row.login;
            }
          return logins;
        });
      },
      fetch: (id, login) => this.provider.getProfileInfo({login: login}),
      process: (id, obj, login) => this.processer.processProfile(id, login, obj),
    });
  }

  /**
   * Regrab user profiles with logins in redis' set "mal.recheckUserLogins"
   */
  recheckUserProfiles(data) {
    let key = 'UserProfiles_Re';
    return this.grabByIds({
      key: key,
      isByListOfIds: true,
      getTotalIdsCnt: () => data.totalIdsCnt,
      getListOfIds: () => data.listOfIds,
      getDataForIds: (indexes) => {
        let logins = {};
        for (let idx of indexes) {
          logins[idx] = data.listOfData[idx];
        }
        return logins;
      },
      fetch: (idx, login) => this.provider.getProfileInfo({login: login}),
      process: (idx, obj, login) => this.processer.processProfile(null, login, obj),
    });
  }

  /**
   * mode - 'WithList' for users with list, 'WithoutList' - for users w/o list,
   *  'Active' for users with list updated not more than year ago, 
   *  'NonActive' for users with list updated long time ago, 'All'
   */
  grabUserListsUpdated(data,  mode = 'All') {
    let key = 'UserListsUpdated_' + mode;
    let cond = "1=1";
    if (mode == 'WithList')
      cond = "list_update_ts is not null and is_deleted = false";
    else if (mode == 'WithoutList')
      cond = "list_update_ts is null and is_deleted = false";
    else if (mode == 'Active')
      cond = "list_update_ts > ('now'::timestamp - '1 year'::interval) and is_deleted = false";
    else if (mode == 'NonActive')
      cond = "list_update_ts < ('now'::timestamp - '1 year'::interval) and is_deleted = false";
    return this.grabByIds({
      key: key,
      getNextIds: (nextId, limit) => {
        return this.db.manyOrNone("\
          select id, login, list_update_ts \
          from malrec_users \
          where id >= $(nextId) and need_to_check_list = false \
            and "+ cond +" \
          order by id asc \
          limit $(limit) \
        ", {
          nextId: nextId,
          limit: limit,
        }).then((rows) => {
          let ids = [], data = {};
          if (rows)
            for (let row of rows) {
              ids.push(parseInt(row.id));
              data[row.id] = {
                login: row.login, 
                listUpdatedTs: row.list_update_ts, 
              };
            }
          return {ids: ids, data: data};
        });
      },
      getTotalIdsCnt: () => data.totalIdsCnt,
      getDataForIds: (ids) => {
        return this.db.manyOrNone("\
          select id, login, list_update_ts \
          from malrec_users \
          where id in (" + ids.join(', ') + ") \
        ").then((rows) => {
          let data = {};
          if (rows)
            for (let row of rows) {
              data[row.id] = {
                login: row.login, 
                listUpdatedTs: row.list_update_ts, 
              };
            }
          return data;
        });
      },
      fetch: (id, data) => {
        return this.provider.getLastUserListUpdates({login: data.login});
      },
      process: (id, updatedRes, data) => {
        return this.processer.processUserListUpdated(id, data.login, 
          data.listUpdatedTs, updatedRes);
      },
    });
  }

  /**
   * mode - 'New' only for users with never checked yet list,
   *  'Updated' - only with flag need_to_check_list == true, 'All'
   */
  grabUserLists(data, mode = 'All') {
    let key = 'UserLists_' + mode;
    let cond = '1=1';
    if (mode == 'New')
      cond = "list_check_ts is null";
    else if (mode == 'Updated')
      cond = "need_to_check_list = true";
    return this.grabByIds({
      key: key,
      getNextIds: (nextId, limit) => {
        return this.db.manyOrNone("\
          select id, login, list_update_ts, list_check_ts, list_id \
          from malrec_users \
          where id >= $(nextId) and "+ cond +" \
          order by id asc \
          limit $(limit) \
        ", {
          nextId: nextId,
          limit: limit,
        }).then((rows) => {
          let ids = [], data = {};
          if (rows)
            for (let row of rows) {
              ids.push(parseInt(row.id));
              data[row.id] = {
                login: row.login, 
                listUpdatedTs: row.list_update_ts, 
                listCheckedTs: row.list_check_ts, 
                listId: row.list_id,
              };
            }
          return {ids: ids, data: data};
        });
      },
      getTotalIdsCnt: () => data.totalIdsCnt,
      getDataForIds: (ids) => {
        return this.db.manyOrNone("\
          select id, login, list_update_ts, list_check_ts, list_id \
          from malrec_users \
          where id in (" + ids.join(', ') + ") \
        ").then((rows) => {
          let data = {};
          if (rows)
            for (let row of rows) {
              data[row.id] = {
                login: row.login, 
                listUpdatedTs: row.list_update_ts, 
                listCheckedTs: row.list_check_ts, 
                listId: row.list_id,
              };
            }
          return data;
        });
      },
      fetch: (id, data) => {
        return this.provider.getUserList({login: data.login});
      },
      process: (id, newList, data) => {
        return this.processer.processUserList(id, data.login, data.listId, 
          newList);
      },
    });
  }

}
var cls = MalScanner; //for using "cls.A" as like "self::A" inside class

module.exports = MalScanner;

