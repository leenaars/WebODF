/**
 * Copyright (C) 2012 KO GmbH <copyright@kogmbh.com>
 *
 * @licstart
 * This file is part of WebODF.
 *
 * WebODF is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Affero General Public License (GNU AGPL)
 * as published by the Free Software Foundation, either version 3 of
 * the License, or (at your option) any later version.
 *
 * WebODF is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with WebODF.  If not, see <http://www.gnu.org/licenses/>.
 * @licend
 *
 * @source: http://www.webodf.org/
 * @source: https://github.com/kogmbh/WebODF/
 */

/*global Components, XPCOMUtils, Services, NetUtil, dump*/

function makeODFStreamConverters() {
    "use strict";
    var Cc = Components.classes,
        Ci = Components.interfaces,
        Cr = Components.results,
        Cu = Components.utils,
        WEBODF_MESSAGE_EVENT_ID = 'webodf.message';

    Cu["import"]('resource://gre/modules/XPCOMUtils.jsm');
    Cu["import"]('resource://gre/modules/Services.jsm');
    Cu["import"]('resource://gre/modules/NetUtil.jsm');

    function log(aMsg) {
        var msg = 'OdfStreamConverter.js: '
            + (aMsg.join ? aMsg.join('') : aMsg);
        Services.console.logStringMessage(msg);
        dump(msg + '\n');
    }

    function getDOMWindow(aChannel) {
        var requestor = aChannel.notificationCallbacks,
            win = requestor.getInterface(Components.interfaces.nsIDOMWindow);
        return win;
    }

    // All the priviledged actions.
    function ChromeActions(domWindow) {
        this.domWindow = domWindow;
    }
    ChromeActions.prototype = {
        download: function (data, sendResponse) {
            var originalUrl = data.originalUrl,
                // The data may not be downloaded so we need just retry getting
                // the odf with the original url.
                originalUri = NetUtil.newURI(data.originalUrl),
                blobUri = data.blobUrl ? NetUtil.newURI(data.blobUrl)
                                       : originalUri,
                extHelperAppSvc =
                    Cc['@mozilla.org/uriloader/external-helper-app-service;1'].
                        getService(Ci.nsIExternalHelperAppService),
                frontWindow = Cc['@mozilla.org/embedcomp/window-watcher;1'].
                             getService(Ci.nsIWindowWatcher).activeWindow,
                listener;

            listener = {
                extListener: null,
                onStartRequest: function (aRequest, aContext) {
                    var path = aRequest.URI.path,
                        mimetype = "application/vnd.oasis.opendocument.";
                    if (path.indexOf("ods") === path.length - 3) {
                        mimetype += "spreadsheet";
                    } else if (path.indexOf("odp") === path.length - 3) {
                        mimetype += "presentation";
                    } else {
                        mimetype += "text";
                    }
                    this.extListener = extHelperAppSvc.doContent(mimetype,
                                aRequest, frontWindow, false);
                    this.extListener.onStartRequest(aRequest, aContext);
                },
                onStopRequest: function (aRequest, aContext, aStatusCode) {
                    if (this.extListener) {
                        this.extListener.onStopRequest(aRequest, aContext,
                            aStatusCode);
                    }
                    // Notify the content code we're done downloading.
                    if (sendResponse) {
                        sendResponse(false);
                    }
                },
                onDataAvailable: function (aRequest, aContext, aInputStream,
                        aOffset, aCount) {
                    this.extListener.onDataAvailable(aRequest, aContext,
                        aInputStream, aOffset, aCount);
                }
            };

            NetUtil.asyncFetch(blobUri, function (aInputStream, aResult) {
                if (!Components.isSuccessCode(aResult)) {
                    if (sendResponse) {
                        sendResponse(true);
                    }
                    return;
                }
                // Create a nsIInputStreamChannel so we can set the url on the
                // channel so the filename will be correct.
                var channel = Cc['@mozilla.org/network/input-stream-channel;1'].
                    createInstance(Ci.nsIInputStreamChannel);
                channel.setURI(originalUri);
                channel.contentStream = aInputStream;
                channel.QueryInterface(Ci.nsIChannel);
                channel.asyncOpen(listener, null);
            });
        }
    };

    // Event listener to trigger chrome privedged code.
    function RequestListener(actions) {
        this.actions = actions;
    }
    // Receive an event and synchronously or asynchronously responds.
    RequestListener.prototype.receive = function (event) {
        var action = event.detail.action,
            data = event.detail.data,
            actions = this.actions;
        if (!(action in actions)) {
            log('Unknown action: ' + action);
            return;
        }
        actions[action].call(this.actions, data);
    };

    /* common base for ODT, ODS and ODP stream converters */
    var OdfStreamConverter = {

        // properties required for XPCOM registration, except classID
        classDescription: 'webodf.js Component',
        contractID: '@mozilla.org/streamconv;1?from=application/vnd.oasis.opendocument.text&to=*/*',

        QueryInterface: XPCOMUtils.generateQI([
            Ci.nsISupports,
            Ci.nsIStreamConverter,
            Ci.nsIStreamListener,
            Ci.nsIRequestObserver
        ]),

        /*
         * This component works as such:
         * 1. asyncConvertData stores the listener
         * 2. onStartRequest creates a new channel, streams the viewer and
         *    cancels the request so webodf.js can do the request
         * Since the request is cancelled onDataAvailable should not be called.
         * The onStopRequest does nothing. The convert function just returns the
         * stream, it's just the synchronous version of asyncConvertData.
         */

        // nsIStreamConverter::convert
        convert: function (aFromStream, aFromType, aToType, aCtxt) {
            throw Cr.NS_ERROR_NOT_IMPLEMENTED;
        },

        // nsIStreamConverter::asyncConvertData
        asyncConvertData: function (aFromType, aToType, aListener, aCtxt) {
            // Ignoring HTTP POST requests -- webodf.js has to repeat the
            // request.
            var skipConversion = false;
            try {
                var request = aCtxt;
                request.QueryInterface(Ci.nsIHttpChannel);
                skipConversion = (request.requestMethod !== 'GET');
            } catch (e) {
                // Non-HTTP request... continue normally.
            }
            if (skipConversion) {
                throw Cr.NS_ERROR_NOT_IMPLEMENTED;
            }

            // Store the listener passed to us
            this.listener = aListener;
        },

        // nsIStreamListener::onDataAvailable
        onDataAvailable: function (aRequest, aContext, aInputStream, aOffset,
                aCount) {
            // Do nothing since all the data loading is handled by the viewer.
            log('SANITY CHECK: onDataAvailable SHOULD NOT BE CALLED!');
        },

        // nsIRequestObserver::onStartRequest
        onStartRequest: function (aRequest, aContext) {

            // Setup the request so we can use it below.
            aRequest.QueryInterface(Ci.nsIChannel);
            // Cancel the request so the viewer can handle it.
            aRequest.cancel(Cr.NS_BINDING_ABORTED);

            // Create a new channel that is viewer loaded as a resource.
            var ioService = Services.io,
                channel = ioService.newChannel(
                    'resource://webodf.js/web/viewer.html',
                    null,
                    null
                ),
                listener = this.listener,
            // Proxy all the request observer calls, when it gets to
            // onStopRequest we can get the dom window.
                proxy = {
                    onStartRequest: function () {
                        listener.onStartRequest.apply(listener, arguments);
                    },
                    onDataAvailable: function () {
                        listener.onDataAvailable.apply(listener, arguments);
                    },
                    onStopRequest: function () {
                        var domWindow = getDOMWindow(channel),
                            requestListener;
                        // Double check the url is still the correct one.
                        if (domWindow.document.documentURIObject.equals(
                                aRequest.URI
                            )) {
                            requestListener = new RequestListener(
                                new ChromeActions(domWindow)
                            );
                            domWindow.addEventListener(WEBODF_MESSAGE_EVENT_ID,
                                function (event) {
                                    requestListener.receive(event);
                                }, false, true, true);
                        }
                        listener.onStopRequest.apply(listener, arguments);
                    }
                };

            // Keep the URL the same so the browser sees it as the same.
            channel.originalURI = aRequest.URI;
            channel.asyncOpen(proxy, aContext);
        },

        // nsIRequestObserver::onStopRequest
        onStopRequest: function (aRequest, aContext, aStatusCode) {
          // Do nothing.
        }
    };

    function OdtStreamConverter() {
    }
    OdtStreamConverter.prototype = {
        // properties required for XPCOM registration:
        classID: Components.ID('{43d50559-3e72-435e-9526-482b93f05bf1}'),
        classDescription: 'OpenDocument Text converter',
        contractID: '@mozilla.org/streamconv;1?from=application/vnd.oasis.opendocument.text&to=*/*',
        QueryInterface: OdfStreamConverter.QueryInterface,
        convert: OdfStreamConverter.convert,
        asyncConvertData: OdfStreamConverter.asyncConvertData,
        onDataAvailable: OdfStreamConverter.onDataAvailable,
        onStartRequest: OdfStreamConverter.onStartRequest,
        onStopRequest: OdfStreamConverter.onStopRequest
    };

    function OdsStreamConverter() {
    }
    OdsStreamConverter.prototype = {
        // properties required for XPCOM registration:
        classID: Components.ID('{5f0cd28d-cd7a-4c38-8dd9-72135474b9bc}'),
        classDescription: 'OpenDocument Spreadsheet converter',
        contractID: '@mozilla.org/streamconv;1?from=application/vnd.oasis.opendocument.spreadsheet&to=*/*',
        QueryInterface: OdfStreamConverter.QueryInterface,
        convert: OdfStreamConverter.convert,
        asyncConvertData: OdfStreamConverter.asyncConvertData,
        onDataAvailable: OdfStreamConverter.onDataAvailable,
        onStartRequest: OdfStreamConverter.onStartRequest,
        onStopRequest: OdfStreamConverter.onStopRequest
    };

    function OdpStreamConverter() {
    }
    OdpStreamConverter.prototype = {
      // properties required for XPCOM registration:
        classID: Components.ID('{84492c35-9c3a-41cc-a512-eb8eb06744a0}'),
        classDescription: 'OpenDocument Presentation converter',
        contractID: '@mozilla.org/streamconv;1?from=application/vnd.oasis.opendocument.presentation&to=*/*',
        QueryInterface: OdfStreamConverter.QueryInterface,
        convert: OdfStreamConverter.convert,
        asyncConvertData: OdfStreamConverter.asyncConvertData,
        onDataAvailable: OdfStreamConverter.onDataAvailable,
        onStartRequest: OdfStreamConverter.onStartRequest,
        onStopRequest: OdfStreamConverter.onStopRequest
    };

    return {
        EXPORTED_SYMBOLS: ['OdtStreamConverter', 'OdsStreamConverter', 'OdpStreamConverter'],
        OdtStreamConverter: OdtStreamConverter,
        OdsStreamConverter: OdsStreamConverter,
        OdpStreamConverter: OdpStreamConverter,
        NSGetFactory: XPCOMUtils.generateNSGetFactory([
            OdtStreamConverter, OdsStreamConverter, OdpStreamConverter])
    };
}
var o = makeODFStreamConverters(),
    EXPORTED_SYMBOLS = o.EXPORTED_SYMBOLS,
    OdtStreamConverter = o.OdtStreamConverter,
    OdsStreamConverter = o.OdsStreamConverter,
    OdpStreamConverter = o.OdpStreamConverter,
    NSGetFactory = o.NSGetFactory;
