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
const args = process.argv.slice(2);

let configPrefix = process.env.configPrefix ? process.env.configPrefix : 'scanner';
var config = require('./config/config-'+configPrefix);

let taskType = args[0] ? args[0] : 'start';

if(taskType == 'help') {
  show_cmd_help();
} else {
  var tq = new MalTaskQueue();
  tq.init(config).then(() => {
    if (taskType == 'test') {
      //test providers
      let typesToTest = ["webProxy", "proxy", "apiClient", "parser"];
      for (let id in tq.allScanners) {
        let sc = tq.allScanners[id];
        if (typesToTest.indexOf(sc.provider.options.type) != -1) {
          sc.provider.loadRss("https://myanimelist.net/rss.php?type=rw&u=SesshouNoKon")
          .then((res) => {
            console.log(sc.id, 'rss ok');
          }).catch((err) => {
            console.log(sc.id, 'rss err', err);
          });
          sc.provider.loadXml("https://myanimelist.net/malappinfo.php?u=DreASU&status=all&type=anime")
          .then((res) => {
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
    } else {
      //run queue loop
      tq.runTaskQueueLoop();
    }
  });
}

function show_cmd_help() {
  console.log("Usage: configPrefix=.. " 
    + "node index.js start|test|help");
  console.log("configPrefix: scanner (default)");
  console.log("start: run queue loop");
  console.log("test: test providers");
  process.exit(0);
}

nodeCleanup(() => {
});

process.on('unhandledRejection', function (err) {
  console.error("!!! Unhandled Rejection", err);
});

process.on('uncaughtException', function (err) {
  console.error("!!! Uncaught Exception", err);
});
