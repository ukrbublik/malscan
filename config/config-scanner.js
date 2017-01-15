var isTest = (process.env.isTest == '1');

//----------------------------------------

var config = {
  isTest: isTest,
	db: {
    host: "localhost",
    port: 5432,
    database: "malrec",
    user: "root",
    password: "toor"
	},
  redis: {
  },
  provider: {
    //default options for all providers, can be overwritten
    logHttp: false,
    retryTimeout: [3000, 5000],
    maxRetries: 7,
    //for type "apiClient": queueSizeConcurrent - size of client's queue, 
    // parserQueueSizeConcurrent - size of server's parser's queue
    //for "parser" - parserQueueSizeConcurrent will be used
    //queueSizeConcurrent - also number of ids to pick per grab portion
    queueSizeConcurrent: 20,
    parserQueueSizeConcurrent: 10,
  },
  providers: {
    prs: {
      type: "parser",
      addr: null,
    },
    /*
    //examples:
    api_cli_1: {
      type: "apiClient",
      addr: "http://1.1.1.1:8800",
    },
    web_proxy_1: {
      type: "webProxy",
      webProxyType: "Glype", //Glype, PHProxy
      addr: 'http://www.secretproxy.org',
    },
    proxy_1: {
      type: "proxy",
      addr: "1.1.1.1:3128",
    },
    */
  },
  scanner: {
    approxBiggestUserId: (isTest ? 130 : 5910700), //manually biggest found user id
    maxNotFoundUserIdsToStop: (isTest ? 20 : 300),
    //maxNotFoundAnimeIdsToStop: (isTest ? 20 : 100),
    log: (isTest ? true : false),
    cntErrorsToStopGrab: (isTest ? 5 : 20),
    saveProcessingIdsAfterEvery: (isTest ? 10 : 50),
  },
  tasks: {
    //see below
  },
  taskQueue: {
    retryTaskTimeout: 1000*10, //10s
    badProviderCooldownTime: 1000*30, //30s
    badResultsToMarkAsDead: 5,
  },
};

let quickTasks = ['UserLogins_New'];
for (let taskName of quickTasks) {
  config.tasks[taskName] = {
    queueSizeConcurrent: 60,
    parserQueueSizeConcurrent: 40,
  };
}

let slowTasks1 = ['UserLists_New'];
for (let taskName of slowTasks1) {
  config.tasks[taskName] = {
    queueSizeConcurrent: 20,
    parserQueueSizeConcurrent: 3,
  };
}

//----------------------------------------

if (isTest) {
  for (let i = 0 ; i <= 10 ; i++) {
    let k = 'test'+i;
    config.providers[k] = {
      type: "parser",
      addr: null,
    };
  }
}


module.exports = config;

