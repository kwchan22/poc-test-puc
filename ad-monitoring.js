function runTWCMonitoring() {
  window.twcMonitoring = {
    adInfoObj: {
      creativeId: "%ecid!",
      lineItemId: "%eaid!",
      height: '%%HEIGHT%%',
      width: '%%WIDTH%%'
    }
  };
  const iasPixels = [];
  const errorNetworkRequests = [];
  let networkRequestInProgress = [];
  const consoleErrors = [];
  // Options for the observer (which mutations to observe)
  const mutationConfig = { attributes: false, childList: true, subtree: true };

  function sendAppEvent(data) {
    let logAppEvent = false;
    let logPayload = {}
    if (typeof ucTagData !== "undefined") {
      data.ucTag = ucTagData;
      logPayload.adId = ucTagData.adId
      logPayload.uuid = ucTagData.uuid
      logPayload.size = ucTagData.size
      logPayload.winbidid = ucTagData.winbidid
      logPayload.hbPb = ucTagData.hbPb
    }
    if (typeof Goog_Omid_SdkImpressionReceived !== "undefined") {
      data.impressionReceived = Goog_Omid_SdkImpressionReceived;
    }
    if (iasPixels.length > 0) {
      let ias = iasPixels[ iasPixels.length - 1 ];
      console.log('iasPixels used for appEvent: ', ias);
      data.ias = { piv: ias.piv, obst: ias.obst };
      logPayload.iasPiv = ias.piv;
      logPayload.iasObst = ias.obst;
    }
    if (typeof window.$dv !== "undefined") {
      data.dv = {
        omidVendorKey: window.$dv.omidVendorKey,
        renderedImpressions: window.$dv.pubSub?.renderedImpressions
      }
    }

    if (data.type === "content-load-error") {
      logAppEvent = true;
      logPayload.reason = data.message;
      logPayload.networkReqError = data.networkReqError;
    } else {
      // Check for prebid cache error
      const fatalNetworkReqError = errorNetworkRequests.find(function (n) {
        return n.src.match(/rubiconproject.com\/cache\?uuid/gi) !== null
      });

      if (fatalNetworkReqError) {
        logAppEvent = true; // tells app to log this event
        logPayload.networkReqError = fatalNetworkReqError;
      }
    }

    data.reason = fatalNetworkReqError ? fatalNetworkReqError : '';
    data.errorNetworkRequests = errorNetworkRequests;
    data.networkRequestInProgress = networkRequestInProgress;
    data.consoleErrors = consoleErrors;
    data.adInfoObj = twcMonitoring.adInfoObj;
    data.logAppEvent = logAppEvent;
    data.logPayload = logPayload;
    console.info(`******sendAppEvent:: app event with ${data.message} ${data.error}`, data);
    admob.events.dispatchAppEvent('adWebviewMessage', JSON.stringify(data));
  }

  async function waitForInitialization() {
    await new Promise((resolve) => {
      const job = setInterval(() => {
        if (typeof admob !== "undefined") {
          clearInterval(job);
          resolve();
        }
      }, 100);
    });
  }

  // function hasDVTags() {
  //   return typeof window.$dv !== 'undefined' && JSON.stringify(window.$dv.tags) !== '{}';
  // }

  function mutationCallback(mutationList, observer) {
    for (const mutation of mutationList) {
      if (mutation.type === "childList") {
        if (mutation.addedNodes.length > 0) {
          console.log("===MutationObserver: A child node has been added.", mutation);
        } else if (mutation.removedNodes.length > 0) {
          console.log("===MutationObserver: A child node has been removed.", mutation);
        }
        mutation.addedNodes.forEach((e) => {
          if (e.nodeType === 3 || e.nodeName === 'BOUNDTEST' || e.nodeType === 8) return; // skip text nodes
          e?.querySelectorAll('iframe, img').forEach((e) => {
            if (!e.src || e.src.startsWith('data:') || e.src === '' || e.src.startsWith('about')) return; // skip data urls
            if (!networkRequestInProgress.includes(e.src)) {
              networkRequestInProgress.push(e.src);
            }
            let mark = false
            const iframeCheckJob = setTimeout(() => {
              //twcMonitoring.sendAppEvent({ message: `iFrame is taking too long to load: ${e.src}`, type: "content-load" });
              mark = true;
            }, 2000);
            e.addEventListener('load', () => {
              clearTimeout(iframeCheckJob);
              networkRequestInProgress = networkRequestInProgress.filter((networkReq) => networkReq != e.src);
              console.info(`===MutationObserver: ${e.tagName} loaded: src: ${e.src}`)
              if (mark && e.src.match(/amazon|prebid/gi) !== null) {
                twcMonitoring.sendAppEvent({ message: `iFrame loaded after timeout: ${e.src}`, type: "content-load-error", networkReqError: e.src });
              }
            });
          });
        });
      }
    }
  }

  function startup() {

    // monitor network requests
    const perfObserver = new PerformanceObserver(captureNetworkRequest);
    perfObserver.observe({ type: "resource", buffered: true });

    console.info('Document readyState::::', document.readyState);
    if (document.readyState === 'complete') {
      initMonitoring()
    } else {
      window.addEventListener('DOMContentLoaded', () => initMonitoring())
    }
  }

  function initMonitoring() {
    console.info('initMonitoring....');
    // Callback function to execute when mutations are observed

    // Create an observer instance linked to the callback function
    window.twcMutationObs = new MutationObserver(mutationCallback);

    // Start observing the target node for configured mutations
    window.twcMutationObs.observe(document.body, mutationConfig);
  }

  function captureNetworkRequest(list, observer) {
    console.log("captureNetworkRequest: ", list);
    list?.getEntries().forEach(function (entry) {
      if (entry.initiatorType.match(/script|img|iframe/)) {
        console.log(`*******Performance Observer:: Capture network request: ${entry.name} status: ${entry.responseStatus}`, entry);

        if (entry.responseStatus >= 300) {
          logNetworkErrorRequest(entry.name, entry.responseStatus);
        } else if (entry.duration > 5000) {
          logNetworkErrorRequest(entry.name, entry.responseStatus, "Request took too long to complete");
        }

        if (entry.name.match(/adsafeprotected/)) {
          const iasURL = new URL(entry.name);
          const iasParams = iasURL.searchParams.get("tv");
          if (iasParams != null) {
            const kvs = extractKeyValue(iasParams);
            if (kvs.hasOwnProperty('piv')) {
              let appEventData = null;
              if (iasPixels.length > 0) {
                // if (iasPixels[ iasPixels.length - 1 ].piv !== kvs.piv) {
                //   appEventData = { message: `IAS PIV changed: ${iasPixels[ iasPixels.length - 1 ].piv} -> ${kvs.piv}`, type: "ias" };
                // }
              } else {
                // send the first IAS pixel
                appEventData = { message: `First IAS pixel: ${kvs.piv}`, type: "ias" };
              }
              iasPixels.push(kvs);
              if (appEventData !== null) {
                sendAppEvent(appEventData);
              }
            }
          }
        }
      }
    });
    console.log("iasPixels: ", iasPixels);
  }

  function extractKeyValue(str) {
    const regex = /(\w+):([\w\s]+)(?:,|$)/g;
    let match;
    const result = {};

    while ((match = regex.exec(str)) !== null) {
      const key = match[ 1 ].trim();
      const value = match[ 2 ].trim();
      result[ key ] = value;
    }
    return result;
  }

  function logNetworkErrorRequest(src, code, message) {
    const strCode = code + ""
    if (errorNetworkRequests.find((n) => n.src === src)) return;
    else errorNetworkRequests.push({ src, strCode, message });
  }

  let oldXHROpen = window.XMLHttpRequest.prototype.open;
  window.XMLHttpRequest.prototype.open = function (method, url, async, user, password) {
    this._url = url; // Store the URL for later use if needed
    oldXHROpen.apply(this, arguments);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    let self = this;
    this.addEventListener('readystatechange', function () {
      const url = self._url
      if (this.readyState === 4) {
        if (this.status >= 300 || this.status === 0) { // error
          let json = {}
          try {
            json = JSON.parse(this.responseText); // check if we have a json response
          } catch (err) {
            json = { message: this.responseText }
          }
          logNetworkErrorRequest(ur, this.statue, json.message);
        }
        networkRequestInProgress = networkRequestInProgress.filter(url => url !== url)
        console.log(`remove completed request: ${this.readyState} ${url}`, networkRequestInProgress);
      } else {
        if (url && url !== '' && !networkRequestInProgress.includes(url)) {
          console.log(`readyState: ${this.readyState} url:${url}`);
          networkRequestInProgress.push(url)
        }
      }
    });
    originalSend.apply(this, args);
  };

  const originalFetch = window.fetch;
  window.fetch = async (...args) => {
    // Request interception
    const request = new Request(...args);
    console.log('#######Request intercepted:', request.url, request.method);
    if (!networkRequestInProgress.includes(request.url)) {
      networkRequestInProgress.push(request.url);
    }

    let response = await originalFetch(request);

    // Response interception
    console.log('########Response intercepted:', request.url, response.status);

    networkRequestInProgress = networkRequestInProgress.filter(url => url !== request.url);

    // Modify response (example: change status)
    if (response.status >= 300) {
      logNetworkErrorRequest(request.url, response.status, await response.text());
    }
    return response;
  };

  const originalConsoleError = console.error;
  console.error = function (...args) {
    const data = { type: 'consoleError' }
    if (typeof args[ 0 ] === 'string') {
      data.message = args[ 0 ];
    } else if (typeof args[ 0 ] === 'object') {
      data.message = args[ 0 ].message || args[ 0 ].msg || args[ 0 ];
    }
    consoleErrors.push(data.message)
    console.warn("console.error intercepted: " + data.message, args);
    originalConsoleError.apply(console, args);
  }

  startup()

  waitForInitialization().then(() => {
    console.info('TWCMonitoring is initialized....' + (typeof Goog_Omid_SdkImpressionReceived) + '  omid: ' + window.Goog_Omid_SdkImpressionReceived);
    const job = setInterval(() => {
      if (typeof Goog_Omid_SdkImpressionReceived !== 'undefined' && Goog_Omid_SdkImpressionReceived === true) {
        sendAppEvent({ message: 'OMID Impression Received', type: 'omid' });
        clearInterval(job);
      }
    }, 100)
  });

  twcMonitoring.sendAppEvent = sendAppEvent;
  twcMonitoring.waitForInitialization = waitForInitialization;
  twcMonitoring.mutationCallback = mutationCallback;
  twcMonitoring.networkRequestInProgress = networkRequestInProgress;
  twcMonitoring.errorNetworkRequests = errorNetworkRequests;

};
console.log('runTWCMonitoring.....');
runTWCMonitoring();