const mediasoup = require('mediasoup-client');
const socketClient = require('socket.io-client');
const socketPromise = require('./lib/socket.io-promise').promise;
const config = require('./config');

const hostname = window.location.hostname;

let device;
let socket;

const $ = document.querySelector.bind(document);
const $fsPublish = $('#fs_publish');
const $btnConnect = $('#btn_connect');
const $btnWebcam = $('#btn_webcam');
const $inputRoom = $('#input_room');
const $txtConnection = $('#connection_status');
const $txtWebcam = $('#webcam_status');
const $txtSubscription = $('#sub_status');
const $videoRemote = $('#remote_video');
let $txtPublish;

$btnWebcam.addEventListener('click', publish);
$btnConnect.disabled = true;
$inputRoom.disabled = true;

let url_string = window.location.href;
let url = new URL(url_string);

let consumerTransport;
const stream = new MediaStream();

async function createConsumerTransport() {
  const recvParams = await handleEvent(await socket.request('createConsumerTransport', { forceTcp: true }));
  const transport = device.createRecvTransport(recvParams);

  transport.on('connect', ({ dtlsParameters }, callback, errback) => {
    console.log(this)
    socket.request('connectConsumerTransport', {
      transportId: transport.id,
      dtlsParameters
    })
      .then(callback)
      .catch(errback);
  });

  transport.on('connectionstatechange', async (state) => {
    switch (state) {
      case 'connecting':
        $txtSubscription.innerHTML = 'connecting...';
        break;

      case 'connected':
        document.querySelector('#remote_video').srcObject = await stream;
        $txtSubscription.innerHTML = 'connected';
        break;

      case 'disconnect':
        transport.close();
        delete consumerTransport;
        $txtSubscription.innerHTML = 'disconnected';
        break;

      case 'failed':
        transport.close();
        $txtSubscription.innerHTML = 'failed';
        break;

      default: break;
    }
  });
  return transport;
}

document.addEventListener("DOMContentLoaded", connect)

async function connect() {
  $txtConnection.innerHTML = 'Connecting...';
  let rtp

  const opts = {
    path: '/server',
    transports: ['websocket'],
  };

  const serverUrl = `https://${hostname}:${config.listenPort}`;
  socket = socketClient(serverUrl, opts);
  socket.request = socketPromise(socket);

  socket.on('connect', async () => {
    $txtConnection.innerHTML = 'Connected';
    $fsPublish.disabled = false;
  });

  socket.on('announceRtpCapabilities', (data) => {
    console.log(0)
    try {
      device = new mediasoup.Device();
    } catch (error) {
      if (error.name === 'UnsupportedError') {
        console.error('browser not supported');
        return;
      }
    }

    try {
      let routerRtpCapabilities = data;
      device.load({ routerRtpCapabilities });
      $btnConnect.disabled = false;
      $inputRoom.disabled = false;
      $btnConnect.addEventListener('click', subscribe);

    } catch (error) {
      if (error.name === 'InvalidStateError') {
        console.error('device already loaded');
      } else if (error.name === 'TypeError') {
        console.error('invalid router RTP capabilities : '+JSON.stringify(routerRtpCapabilities));
      } else {
        console.error('unknow error while loading device', error);
      }
    }
  });

  socket.on('disconnect', () => {
    $txtConnection.innerHTML = 'Disconnected';
    $btnConnect.removeEventListener('click', joinRoom);
    $fsPublish.disabled = true;
    $btnConnect.disabled = true;
    $inputRoom.disabled = true;
  });

  socket.on('connect_error', (error) => {
    console.error('could not connect to %s%s (%s)', serverUrl, opts.path, error.message);
    $txtConnection.innerHTML = 'Connection failed';
    $btnConnect.disabled = true;
  });

  socket.on('newStream', async (data) => {
    const { kind } = data;
    console.log(kind, data);
    if (typeof consumerTransport === 'undefined') {
      consumerTransport = await createConsumerTransport();
    }
    stream.addTrack(await consume(kind));

    await socket.request('resume', { kind });

    if ($videoRemote.paused) {
      $videoRemote.play()
    }
  });
}

async function subscribe() {
  handleEvent(await socket.request('joinRoom', { room: $inputRoom.value }));
}

async function publish(e) {
  $txtPublish = $txtWebcam
  const room = $inputRoom.value;
  const jwt = {}; // TODO

  $txtPublish.innerHTML = 'asking server for streaming connection';
  const data = await socket.request('createProducerTransport', {
    jwt,
    room,
    forceTcp: false,
    rtpCapabilities: device.rtpCapabilities,
  });

  $txtPublish.innerHTML = 'creating client streaming connection';
  const transport = device.createSendTransport(data);
  transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
    socket.request('connectProducerTransport', { room, jwt, dtlsParameters })
      .then(callback)
      .catch(errback);
  });

  transport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
    console.log(kind)
    try {
      const { id } = await socket.request('produce', {
        jwt,
        room,
        transportId: transport.id,
        kind,
        rtpParameters,
      });
      callback({ id });
    } catch (err) {
      errback(err);
    }
  });

  transport.on('connectionstatechange', (state) => {
    switch (state) {
      case 'connecting':
        $txtPublish.innerHTML = 'publishing...';
        $fsPublish.disabled = true;
      break;

      case 'connected':
        document.querySelector('#local_video').srcObject = stream;
        $txtPublish.innerHTML = 'published';
        $fsPublish.disabled = true;
      break;

      case 'failed':
        transport.close();
        $txtPublish.innerHTML = 'failed';
        $fsPublish.disabled = false;
      break;

      default: break;
    }
  });

  let stream;
  try {
    // TODO add timeout and ask user to restart browser. Page reload is NOT sufficient
    // failures can happend when: pulseaudio/audio driver crashed/restarted, USB micro/webcam was disconnected, etc...
    // in summary can fail when chrome and operating system audio/video states gets out of sync
    $txtPublish.innerHTML = 'waiting for audio and video';
    const stream = await getUserMedia(transport);

    // Video
    const videoParams = { 
      track: stream.getVideoTracks()[0]
    };
    console.log('producing video');
    $txtPublish.innerHTML = 'start sending video stream';
    let videoProducer = await transport.produce(videoParams);
    console.log('bite')

    // Audio
    const audioParams = { 
      track: stream.getAudioTracks()[0]
    };
    console.log('producing audio');
    $txtPublish.innerHTML = 'start sending audio stream';
    let audioProducer = await transport.produce(audioParams);
  } catch (err) {
    console.error(err)
    $txtPublish.innerHTML += 'failed';
  }
}

async function getUserMedia(transport) {
  if (!device.canProduce('video')) {
    console.error('cannot produce video');
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    console.error('getUserMedia() failed:', err.message);
    throw err;
  }
  return stream;
}

async function handleEvent(data) {
  if (data.hasOwnProperty('error')) {
    console.error(data.error);

    if (data.error.hasOwnProperty('action')) {
      switch (data.error.action) {
        case 'disconnect':
          socket.disconnect();
        break;

        case 'refresh':
          socket.disconnect();
          location.reload(true);
        break;

        default:
          console.error('HandleAction : unknow action ' + JSON.stringify(data.error.action));
      }
    }
    throw Error(data.error);
  }
  console.log('callback');
  return data;
}

async function joinRoom() {
  let room = $inputRoom.value
  const data = handleEvent(await socket.request('joinRoom', { room }));
}

async function consume(kind) {
  const { rtpCapabilities } = device;
  const room = $inputRoom.value;
  const track = await socket.request('consume', { kind, rtpCapabilities, room });
  const consumer = await consumerTransport.consume(track);

  return consumer.track;
}
