const mediasoup = require('mediasoup');
const fs = require('fs');
const https = require('https');
const express = require('express');
const socketIO = require('socket.io');
const config = require('./config');

// Global variables
const rooms = {};
const consumers = {};
let worker;
let webServer;
let socketServer;
let expressApp;
let mediasoupRouter;

(async () => {
  try {
    await runExpressApp();
    await runWebServer();
    await runSocketServer();
    await runMediasoupWorker();
  } catch (err) {
    console.error(err);
  }
})();

// Placeholders for logs and i18n
// TODO implement
const i18n = function(strings, ...values){
  let result = "";

  for(let i = 0; i < strings.length; i++) {
    result += strings[i];
    if (i < values.length) {
      result += values[i]
    }
  }
  return result;
}

const log = {
  emerg: console.error,
  crit: console.error,
  error: console.error,
  warn: console.warn,
  info: console.info,
  notice: console.info,
  debug: console.info,
}

async function runExpressApp() {
  expressApp = express();
  expressApp.use(express.json());
  expressApp.use(express.static(__dirname));

  expressApp.use((error, req, res, next) => {
    if (error) {
      log.warn('express', 'Express app error', error.message);

      error.status = error.status || (error.name === 'TypeError' ? 400 : 500);

      res.statusMessage = error.message;
      res.status(error.status).send(String(error));
    } else {
      next();
    }
  });
}

async function runWebServer() {
  const { sslKey, sslCrt } = config;
  if (!fs.existsSync(sslKey) || !fs.existsSync(sslCrt)) {
    log.emerg('express', `SSL files are not found. check your config.js file : ${JSON.stringify({key: sslKey, crt: sslCrt})}`);
    process.exit(1);
  }
  const tls = {
    cert: fs.readFileSync(sslCrt),
    key: fs.readFileSync(sslKey),
  };
  webServer = https.createServer(tls, expressApp);
  webServer.on('error', (err) => {
    log.emerg('express', 'starting web server failed', err);
  });

  await new Promise((resolve) => {
    const { listenIp, listenPort } = config;
    webServer.listen(listenPort, listenIp, () => {

      const listenIps = config.mediasoup.webRtcTransport.listenIps[0];
      const ip = listenIps.announcedIp || listenIps.ip;
      log.notice('express', 'server is running');
      try {
        const uid = parseInt(process.env.SUDO_UID, 10)
        const gid = parseInt(process.env.SUDO_GID, 10)
        process.setgid(gid);
        process.setuid(uid);
      } catch (e) {
        log.emerg('express', `Could not drop privileges from root to UID=${uid} GID=${gid})`, e);
        process.exit(2);
      }
      resolve();
    });
  });
}

async function checkAcl(jwt) {
  return true;
}

async function runSocketServer() {
  // DO NOT run this app with external SocketIO adapter, like Redis
  // This application manages networks ports on local machine via
  // an external daemon. Connections states are tied to the machine
  // Instead use the clustering feature of njord
  socketServer = socketIO(webServer, {
    serveClient: false,
    path: '/server',
    log: false,
  });
  socketServer.on('connection', (socket) => {
    let consumer = { 
      audio: null,
      video: null
    }
    let roles = [];

    const socketlog = {
      emerg: function(eventName, message, error) {
        log.emerg('socket',`Client ${socket.id}; Event ${eventName}; ${message}`, error);
      },
      crit: function(eventName, message, error) {
        log.crit('socket',`Client ${socket.id}; Event ${eventName}; ${message}`, error);
      },
      error: function(eventName, message, error) {
        log.error('socket',`Client ${socket.id}; Event ${eventName}; ${message}`, error);
      },
      info: function(eventName, message) {
        log.info('socket',`Client ${socket.id}; Event ${eventName}; ${message}`);
      },
      warn: function(eventName, message) {
        log.warn('socket',`Client ${socket.id}; Event ${eventName}; ${message}`);
      },
      notice: function(eventName, message) {
        log.notice('socket',`Client ${socket.id}; Event ${eventName}; ${message}`);
      },
      debug: function(eventName, message) {
        log.debug('socket',`Client ${socket.id}; Event ${eventName}; ${message}`);
      }
    };

    socketlog.info('connection', 'connected');

    socket.emit('announceRtpCapabilities', mediasoupRouter.rtpCapabilities);

    socket.on('joinRoom', (data, callback) => {
      roles.push('consumer')     
      let { room } = data;
      if (typeof room === 'undefined' ) {
          const msg = 'called joinRoom without the room parameter';
          socketlog.error('joinRoom', msg, Error(msg))
      }
      try {
        console.log(rooms[room].streams)
        for (let kind of ['audio','video']) {
          if (!rooms.hasOwnProperty(room)) {
            const msg = `tried to change to a non-existing room ${room}`;
            socketlog.error('joinRoom', msg, Error(msg));
            callback({error: i18n`room ${room} does not exists`, action: 'disconnect'});
          }
          // If rooms already contain a producer, inform client
          else if ( rooms[room].streams.hasOwnProperty(kind)) {
            socketlog.debug('joinRoom', `joined room ${room} which have active ${kind} producer. sending newStream event to client`);
            socket.emit('newStream', { kind });
          }
        }
      } catch (error) {
        try {
          callback({'error': i18n`unhandled error`})
          socketlog.error('changeRoom', `encountered an error while changing to room ${room}`, error)
        } catch (error_callback) {
          socketlog.error('changeRoom', `encountered an error while changing to room ${room} and the answer message could not be sent to client failed too`, {error: error, callBackError: error_callback})
        }
      }
    });

    socket.on('disconnect', () => {
      // If the socket is a producer we inform other clients in the room that it's disconnecting
      if (roles.indexOf('producer') !== -1) {
        const roomName = socket.room
      	socketServer.in(roomName).emit('producerDisconnected')
      }
      socketlog.notice('disconnect', 'disconnected');
    });

    socket.on('connect_error', (error) => {
      socketlog.warn('connect_error', 'client connection error', error);
    });

    socket.on('createConsumerTransport', async (data, callback) => {
      socketlog.debug('createConsumerTransport', 'Creating consumer transport')
      try {
        const { transport, params } = await createWebRtcTransport();
        socketlog.notice('createConsumerTransport', `created consumer transport with parameters ${JSON.stringify(params)}`)
        consumers[socket.id] = {
          streams: {},
          clientSideTransport: transport
        }
        callback(params);
      } catch (err) {
        socketlog.error('createConsumerTransport', 'error while trying to create consumer transport', err);
        callback({ error: i18n`error while trying to create server-side consumer transport` });
      }
    });

    socket.on('connectConsumerTransport', async (data, callback) => {
      socketlog.debug('createConsumerTransport', 'Connnecting consumer transport');
      try {
        const { dtlsParameters } = data
        await consumers[socket.id].clientSideTransport.connect({ dtlsParameters: dtlsParameters });
        socketlog.notice('connectConsumerTransport', `connected consumer transport with parameters ${JSON.stringify(dtlsParameters)}`)
        callback({});
      } catch (e) {
        socketlog.error('connectConsumerTransport', `failed to connect to consumer transport`, e)
        callback({error: i18n`error while trying to connect server-side consumer transport`});
      }
    });

    socket.on('createProducerTransport', async (data, callback) => {
      socketlog.debug('createProducerTransport', 'creating producer transport')
      try {

        let { room, jwt, forceTcp, rtpCapabilities } = data;

        if ( typeof room === 'undefined' ) {
          socketlog.crit('createProducerTransport', `tried to create producer transport without room`,)
          callback({ error: i18n`room doesn't exists`, action: 'refresh' });
          return;
        }

        if ( ! await checkAcl(jwt, room)) {
          socketlog.warn('createProducerTransport', `access refused to room ${room}. Session ${JSON.stringify(jwt)}`)
          callback({ error: i18n`access refused`, action: 'refresh' });
          return;
        }

        socketlog.debug('createProducerTransport', `creating ${room} transport`)
        const { transport, params } = await createWebRtcTransport();

        if ( ! rooms.hasOwnProperty(room) ) {
          socketlog.info('createProducerTransport', `creating ${room}`)
          roles.push('producer')
          rooms[room] = { streams: {}}

          rooms[room].transport = transport;
          callback(params);
        } else {
          socketlog.warn('createProducerTransport', `tried to produce in the existing room ${room}`); // TODO : send reconnect is transport exists
          callback({'error': i18n`this room already exists`});
        }
      } catch (err) {
        socketlog.error('createProducerTransport', 'Error while creating a producer transport', err);
        callback({ error: i18n`error while creating the steaming transport connection` });
      }
    });


    socket.on('connectProducerTransport', async (data, callback) => {
      socketlog.debug('connectProducerTransport', 'connecting producer transport')
      try {
        const { room, jwt, dtlsParameters } = data;
        if ( typeof room === 'undefined' ) {
          const error = Error('tried to produce stream without room');
          socketlog.crit('connectProducerTransport', error.message, error)
          callback({ error: i18n`room doesn't exists`, action: 'refresh' });
          return;
        }

        if ( ! await checkAcl(jwt, room, 'produce')) {
          socketlog.warn('connectProducerTransport', `access refused to room ${room}. Session ${JSON.stringify(jwt)}`)
          callback({ error: i18n`access refused`, action: 'refresh' });
          return;
        }

        await rooms[room].transport.connect({ dtlsParameters });
        socketlog.info('connectProducerTransport', `Client ${socket.id} connected producer transport`, dtlsParameters)
        callback(true);
      } catch (error) {
        socketlog.error('connectProducerTransport', `Client ${socket.id} failed to connect to producer transport`, error)
        callback(false);
      }
    });

    socket.on('produce', async (data, callback) => {
      socketlog.debug('produce', 'produce')
      try {
        const { jwt, room, kind, rtpParameters } = data;

        if ( typeof room === 'undefined' ){
          const error = Error('tried to produce stream without room');
          socketlog.crit('produce', error.message, error)
          callback({ error: i18n`room doesn't exists`, action: 'refresh' });
          return;
        }

        if ( ! await checkAcl(jwt, room) ){
          socketlog.warn('produce', `access refused to room ${room}. Session ${JSON.stringify(jwt)}`)
          callback({ error: i18n`access refused`, action: 'refresh' });
          return;
        }


        roles.push('producer')
        socketlog.info('produce', `sending new ${kind} stream in room ${room} with parameters ${JSON.stringify(rtpParameters)}`)

        if ( !rooms[room].streams.hasOwnProperty(kind) ) {
          rooms[room].streams[kind] = {}
        }

	      // Save stream in the room
        rooms[room].streams[kind].stream = await rooms[room].transport.produce({ kind, rtpParameters });
        rooms[room].streams[kind].publisherId = socket.id
        callback({ id: rooms[room].transport.id });

        // inform clients about new producer
        socketlog.debug('produce', `send newStream event to clients in room ${room}`)
        socketServer.in(room).emit('newStream', { kind });

      } catch (error) {
        socketlog.error('produce', `error while trying to send producer stream to transport`, error)
      }
    });

    socket.on('consume', async (data, callback) => {
      log.debug('consume', 'consume');
      console.log(data)
      try {
        const { room, kind, rtpCapabilities } = data;
        if (typeof room === 'undefined' ) {
            const msg = 'no room provided';
            socketlog.error('consume', msg, Error(msg))
            callback({'error': i18n`no room provided`, action: 'refresh'});
        }
        if (typeof kind === 'undefined' ) {
            const msg = 'no stream kind provided';
            socketlog.error('consume', msg, Error(msg))
            callback({'error': i18n`no stream kind provided`, action: 'refresh'});
        }
  
        if ( ['audio','video'].indexOf(kind) === -1 ) {
          socketlog.error('consume', `asked to consume an unknow type of stream : ${JSON.stringify(kind)}`);
          callback({'error': i18n`no ${kind} producer is streaming in this room`});
        } else if (rooms[room].streams.hasOwnProperty(kind)) {
          socketlog.notice('consume', `subscribed to producer ${rooms[room].streams[kind].id} ${kind} stream`,);
          const consumerTransport = await createConsumer(socket.id, room, kind, rtpCapabilities);
          if (consumerTransport === false) {
            socketlog.error('consume', `error while trying to create server-side consumer transport a`);
            callback({error: i18n`error while trying to create server-side consumer transport`});
          } else {
            callback(consumerTransport);
          }
        } else {
          socketlog.warn('consume' `asked to consume ${kind} but no ${kind} producer is streaming right now`)
          callback({'error': i18n`no "${kind}" producer is streaming`});
        }
      } catch (error) {
        socketlog.error('consume', `error while trying to consume`, error)
      }
    });

    socket.on('resume', async (data, callback) => {
      socketlog.debug('resume', 'resuming stream')
      try {
        const { kind } = data;
  
        if (['audio','video'].indexOf(kind) === -1) {
          socketlog.error('resume', `asked to resume an unknow type of stream ${JSON.stringify(kind)}`);
  
        } else if (!consumers.hasOwnProperty(socket.id)) {
          const msg = `client doesn't have a transport`
          socketlog.warn('resume', msg, Error(msg))
          callback({'error': `client doesn't have a transport`, action: 'refresh'})

        } else if (!consumers[socket.id].streams.hasOwnProperty(kind)) {
          const msg = `asked to resume consumer ${kind} but no ${kind} consumer is available right now`
          socketlog.warn('resume', msg, Error(msg))
          callback({'error': `no "${kind}" consumer is available to resume`, action: 'refresh'})
  
        } else {
          socketlog.info('resume', `resumed ${kind} stream`)
          await consumers[socket.id].streams[kind].resume();
          callback();
        }
      } catch (error) {
        socketlog.error('resume', 'error while trying to resume stream', error)
      }
    });
  });
}

async function runMediasoupWorker() {
  worker = await mediasoup.createWorker({
    logLevel: config.mediasoup.worker.logLevel,
    logTags: config.mediasoup.worker.logTags,
    rtcMinPort: config.mediasoup.worker.rtcMinPort,
    rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
  });

  worker.on('died', () => {
    log.emerg('mediasoupworker', 'mediasoup worker died, exiting in 2 seconds... [pid:%d]', worker.pid);
    setTimeout(() => process.exit(1), 2000);
  });

  const mediaCodecs = config.mediasoup.router.mediaCodecs;
  mediasoupRouter = await worker.createRouter({ mediaCodecs });
}

async function createWebRtcTransport() {
  const {
    maxIncomingBitrate,
    initialAvailableOutgoingBitrate
  } = config.mediasoup.webRtcTransport;

  const transport = await mediasoupRouter.createWebRtcTransport({
    listenIps: config.mediasoup.webRtcTransport.listenIps,
    enableUdp: false,
    enableTcp: true,
    preferUdp: false,
    preferTcp: true,
    initialAvailableOutgoingBitrate,
  });
  if (maxIncomingBitrate) {
    try {
      await transport.setMaxIncomingBitrate(maxIncomingBitrate);
    } catch (error) {
    }
  }
  return {
    transport,
    params: {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    },
  };
}

async function createConsumer(clientId, room, kind, rtpCapabilities) {
  if ( rooms.hasOwnProperty(room) === -1 ) {
    throw Error(`the room ${room} doesn't exists`);
  }
  if (!rooms[room].streams.hasOwnProperty(kind)) {
    throw Error(`the room ${room} doesn't have a ${kind} stream`);
  }
  if (!consumers.hasOwnProperty(clientId)) {
    throw Error(`no consumer with id ${clientId}`);
  }

  const producer = rooms[room].streams[kind].stream
  if (!mediasoupRouter.canConsume({
      producerId: producer.id,
      rtpCapabilities,
    })) {
    throw Error(`can not consume producer ${producer.id} with rtpCapabilities ${JSON.stringify(rtpCapabilities)}`);
  }

  if (!consumers[clientId].hasOwnProperty('consumers')) {
    consumers[clientId].consumers = {};
  }

  const consumer = await consumers[clientId].clientSideTransport.consume({
    producerId: producer.id,
    rtpCapabilities,
    paused: true,
  });
  consumers[clientId].streams[kind] = consumer;

  return {
    producerId: rooms[room].streams[kind].stream.id,
    id: consumer.id,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters,
    type: consumer.type,
    producerPaused: consumer.producerPaused
  };
}
