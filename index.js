/**
 * MyAnimeList scanner
 *
 * @author ukrbublik
 */

const fs = require('fs');
const MalTaskQueue = require('./lib/mal/MalTaskQueue');
const MalScanner = require('./lib/mal/MalScanner');
const args = process.argv.slice(2);
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
    sc.provider.loadXml("https://myanimelist.net/malappinfo.php?u=DreASU&status=all&type=anime")
    .then((body) => {
      console.log(sc.id, 'ok');
    }).catch((err) => {
      console.log(sc.id, 'err');
    });
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
