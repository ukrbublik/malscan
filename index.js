/**
 * MyAnimeList scanner
 *
 * @author ukrbublik
 */

const fs = require('fs');
const MalTaskQueue = require('./lib/mal/MalTaskQueue');
const MalScanner = require('./lib/mal/MalScanner');
const ProgressBar = require('progress');
const express = require('express');
const http = require('http');
const app = express();
const server = http.Server(app);
const nodeCleanup = require('node-cleanup');

const config = require('./config/config-scanner');

var tq = new MalTaskQueue();
tq.init(config).then(() => {
  tq.runTaskQueueLoop();

  //todo - add tasks to queue by timer or manually from redis
  //tq.addTasksToQueue(MalScanner.grabNewsTasksKeys);
  //tq.addTasksToQueue(MalScanner.grabUpdatesTasksKeys);

  
/*
  //to test proxy
  for (let id in tq.allScanners) {
    let sc = tq.allScanners[id];
    if (sc.provider.options.type == "webProxy") {
      sc.provider.loadXml("https://myanimelist.net/malappinfo.php?u=DreASU&status=all&type=anime")
      .then((body) => {
        console.log(sc.id, 'xml ok');
      }).catch((err) => {
        console.log(sc.id, 'xml err', err);
      });
      sc.provider.loadHtml("https://myanimelist.net/anime/128/some_title")
      .then(($) => {
        if ($('a[href*="/anime/genre/1/Action"]').length > 0)
          console.log(sc.id, 'html ok');
        else
          console.log(sc.id, 'html bad $');
      }).catch((err) => {
        console.log(sc.id, 'html err', err);
      });
    }
  }
*/

});


nodeCleanup(() => {
});

process.on('unhandledRejection', function (err) {
  console.error("!!! Unhandled Rejection", err);
});

process.on('uncaughtException', function (err) {
  console.error("!!! Uncaught Exception", err);
});
