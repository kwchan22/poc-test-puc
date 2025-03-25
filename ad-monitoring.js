window.twcMonitoring = {
  adInfoObj: {
    creativeId: "%ecid!",
    lineItemId: "%eaid!",
    height: '%%HEIGHT%%',
    width: '%%WIDTH%%'
  },
  amznInfo: {
    slots: "%%PATTERN:amznslots%%", 
    bidId: "%%PATTERN:amzn_b%%", 
    skadn: "%%PATTERN:amzn_skadn%%"
  }
};
function runTWCMonitoring() {
  const iasPixels = [];
  const errorNetworkRequests = [];
  let networkRequestInProgress = [];
  const consoleErrors = [];
  // Options for the observer (which mutations to observe)
  const mutationConfig = { attributes: false, childList: true, subtree: true };

  function sendAppEvent(data) {
    let logAppEvent = data.logAppEvent ?? false;
    let logPayload = {}
    let errMsg = "";
    if (typeof ucTagData !== "undefined") {
      // PUC tag data
      logPayload.prebid = {
        adId: ucTagData.adId,
        uuid: ucTagData.uuid,
        size: ucTagData.size,
        winbidid: ucTagData.winbidid,
        hbPb: ucTagData.hbPb,
        env: ucTagData.env,
        adServerDomain: ucTagData.adServerDomain,
        pubUrl: ucTagData.pubUrl
      }
    }

    if (iasPixels.length > 0) {
      let ias = iasPixels[ iasPixels.length - 1 ]; // take the last which is latest
      logPayload.ias = {
        piv: ias.piv,
        obst: ias.obst
      }
    }
    if (typeof window.$dv !== "undefined" && window.$dv.omidVendorKey) {
      logPayload.dv = {
        omidVendorKey: window.$dv.omidVendorKey,
        renderedImpressions: window.$dv.pubSub? window.$dv.pubSub.renderedImpressions : {}
      }
    }
    if (typeof window._aps !== "undefined") {
      console.log("Amazon: aps is available")
      logPayload.amazon = {
        slots: twcMonitoring.amznInfo? twcMonitoring.amznInfo.slots : "",
        bidId: twcMonitoring.amznInfo? twcMonitoring.amznInfo.bidId : "",
        skadn: twcMonitoring.amznInfo? twcMonitoring.amznInfo.skadn : ""
      }
      window._aps.forEach((a) => a.store.entries().forEach((entry) => {
        entry.entries().forEach((histories) => {
          if (Array.isArray(histories[ 1 ]) && histories[ 1 ].length > 0) {
            const evts = histories[1].filter(function (h) {
              return h.type === "maps/ad/render" || h.type === "maps/ad/load";
            });
            console.log("Amazon events:", evts);
            const evt = evts.length > 0 ? evts.pop() : null; // take the last one of the latest
            if (evt && evt.detail && evt.detail.dtbGlobal) {
              const dtbGlobal = evt.detail.dtbGlobal;
              let errorLogs = "";
              if (dtbGlobal.debugState && dtbGlobal.debugState.logs) {
                errorLogs = JSON.stringify(dtbGlobal.debugState.logs.filter(function(l) {
                  return l.match(/abort|error/i) !== null && l.indexOf("pixel evaluation") == -1;
                }));
              }
              console.log("Amazon errorLogs:", errorLogs, dtbGlobal);
              if (errorLogs !== "" && errorLogs !== "[]") {
                logAppEvent = true; // there are errors...log it
              }

              errMsg = "Error loading Amazon ad";
              Object.assign(logPayload.amazon, {
                adFinishedLoadingTime: dtbGlobal.btrPerformance ? dtbGlobal.btrPerformance.adFinishedLoadingTime + "" : "",
                selectedPricePoint: dtbGlobal.selectedPricePoint,
                lineItemId: dtbGlobal.lineItemId,
                size: dtbGlobal.size,
                slotId: dtbGlobal.slotId,
                slotName: dtbGlobal.slotName,
                slotType: dtbGlobal.slotType,
                errorLogs
              });
            }
          }
        })
      }));
    }

    if (data.type === "content-load-error") {
      // there was a request error or took too long to load
      logAppEvent = true;
      errMsg = data.message;
      logPayload.networkErrorURL = data.networkReqErrorURL;
      logPayload.networkErrorCode = 0;
      delete data.message;
      delete data.networkReqErrorURL;
    } else {
      // Check for prebid cache error
      const fatalNetworkReqError = errorNetworkRequests.find(function (n) {
        return n.src.match(/(rubiconproject.com\/cache\?uuid|amazon)/gi) !== null
      });

      if (fatalNetworkReqError) {
        logAppEvent = true; // tells app to log this event
        logPayload.networkErrorURL = fatalNetworkReqError.src;
        logPayload.networkErrorCode = fatalNetworkReqError.code;
        errMsg = fatalNetworkReqError.message;
      }
    }

    data.errorMessage = errMsg;
    data.errorNetworkRequests = errorNetworkRequests;
    data.networkRequestInProgress = networkRequestInProgress;
    data.consoleErrors = consoleErrors;
    data.adInfoObj = twcMonitoring.adInfoObj;
    data.logAppEvent = logAppEvent;
    data.logPayload = logPayload;
    console.info(`sendAppEvent:: app event with ${data.message} ${data.error}`, data);
    admob.events.dispatchAppEvent('adMetricEvent', JSON.stringify(data));
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
          console.log("MutationObserver: A child node has been added.", mutation);
        } else if (mutation.removedNodes.length > 0) {
          console.log("MutationObserver: A child node has been removed.", mutation);
        }
        mutation.addedNodes.forEach((e) => {
          if (e.nodeType === 3 || e.nodeName === 'BOUNDTEST' || e.nodeType === 8) return; // skip text nodes
          e?.querySelectorAll('iframe, img').forEach((e) => {
            if (!e.src || e.src === '' || e.src.match(/about:|data:|googlesyndication/i)) return; // skip data urls
            if (!networkRequestInProgress.includes(e.src)) {
              networkRequestInProgress.push(e.src);
            }
            let mark = false
            const loadTimeThreshold = 2000;
            const iframeCheckJob = setTimeout(() => {
              //twcMonitoring.sendAppEvent({ message: `iFrame is taking too long to load: ${e.src}`, type: "content-load" });
              mark = true;
            }, loadTimeThreshold);
            e.addEventListener('load', () => {
              clearTimeout(iframeCheckJob);
              networkRequestInProgress = networkRequestInProgress.filter((networkReq) => networkReq != e.src);
              console.info(`MutationObserver: ${e.tagName} loaded: src: ${e.src}`)
              if (mark && e.src.match(/amazon|prebid/gi) !== null) {
                twcMonitoring.sendAppEvent({ message: `iFrame loaded after ${loadTimeThreshold} seconds: ${e.src}`, type: "content-load-error", networkReqErrorURL: e.src });
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
    console.log("captureNetworkRequest: ", list?.getEntries());
    list?.getEntries().forEach(function (entry) {
      if (entry.initiatorType.match(/script|img|iframe/)) {
        console.log(`Performance Observer:: Capture network request: ${entry.name} status: ${entry.responseStatus}`, entry);

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
    if (errorNetworkRequests.find((n) => n.src === src)) return;
    else errorNetworkRequests.push({
      src,
      code: "" + code,
      message
    });
  }

  // Intercept XMLHttpRequest
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
        if (url.match(/weather\.com/i) === null && (this.status >= 300 || this.status === 0)) { // error
          let json = {}
          try {
            json = JSON.parse(this.responseText); // check if we have a json response
          } catch (err) {
            json = { message: this.responseText }
          }
          logNetworkErrorRequest(url, this.status, json.message);
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

  // Intercept Fetch API
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

    console.log('########request removed:' + request.url + ' ===>' + networkRequestInProgress.join(','));

    // Modify response (example: change status)
    if (response.status >= 300 && request.url.match(/weather\.com/i) === null) {
      logNetworkErrorRequest(request.url, response.status, await response.text());
    }
    return response;
  };

  // Intercept console errors
  const originalConsoleError = console.error;
  console.error = function (...args) {
    const data = { type: 'consoleError' }
    if (typeof args[0] === 'string') {
      data.message = args[0];
    } else if (typeof args[0] === 'object') {
      data.message = args[0].message || args[0].msg || JSON.stringify(args[0]);
    }
    consoleErrors.push(data.message)
    console.warn("console.error intercepted: " + data.message, args);
    originalConsoleError.apply(console, args);
  }

  // Start monitoring init
  startup()

  waitForInitialization().then(() => {
    console.info('TWCMonitoring is initialized....');
    let impressionCheckedDuration = 0;
    const job = setInterval(() => {
      if (typeof Goog_Omid_SdkImpressionReceived !== 'undefined' && Goog_Omid_SdkImpressionReceived === true) {
        sendAppEvent({ message: 'OMID Impression Received', type: 'omid' });
        clearInterval(job);
      }
      impressionCheckedDuration += 100;
    }, 10)
  });

  twcMonitoring.sendAppEvent = sendAppEvent;
  twcMonitoring.waitForInitialization = waitForInitialization;
  twcMonitoring.mutationCallback = mutationCallback;
  twcMonitoring.networkRequestInProgress = networkRequestInProgress;
  twcMonitoring.errorNetworkRequests = errorNetworkRequests;
  twcMonitoring.logNetworkErrorRequest = logNetworkErrorRequest;
  twcMonitoring.iasPixels = iasPixels;

};
window.twcMonitoringDisabled = "%%PATTERN:fpd%%"
console.log('runTWCMonitoring.....' + window.twcMonitoringDisabled);
if (window.twcMonitoringDisabled != "disabled") {
  runTWCMonitoring();
}
