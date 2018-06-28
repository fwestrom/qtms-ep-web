'use strict';

var _ = require('lodash');
var multer  = require('multer');
var upload = multer();

var bodyParser = require('body-parser');
var crutch = require('qtort-microservices').crutch;
var defaults = {
    defaultExchange: 'topic://api',
    defaultQueue: 'qtms-ep-web',
    defaultReturnBody: false,
    defaultTimeout: 30000,
    enableLogAndReplyDebug: false, // cli arg: --enableLogAndReplyDebug (Can be used to debug api messages)
    port: process.env.npm_package_config_port || 3000,
};

crutch(defaults, function(express, logging, microservices, options, Promise, util) {
    var log = logging.getLogger('qtms-ep-web');

    return Promise
        .try(function() {
            var app = express();

            app.use(bodyParser.json({limit: '1mb'}));
            app.use(bodyParser.urlencoded({limit: '1mb'}));
            app.use('/', bodyParser.json());

            app.all(/\/api(\/.*)?/, upload.any(),function onRequest(request, response) {
                response.set('Access-Control-Allow-Origin', '*');
                response.set('Access-Control-Allow-Headers', 'Content-Type');
                response.set('Access-Control-Allow-Methods', 'GET, OPTIONS, PATCH, POST, PUT, DELETE');
                if (request.method.toUpperCase() === 'OPTIONS') {
                    // TODO: Needs to attempt to call microservice and extend response as well as provide default response.
                    return response.send();
                }

                if(request.headers['content-type'] && request.headers['content-type'].indexOf('multipart/form-data') > -1) {
                    // extend file object to body becouse only body will send microservices

                    request.body  = _.extend(request.body,{files:request.files});

                    //request.body.toString is not a function for multi part object , toString is required by qtort-microservices
                    request.body.toString =function(){
                        return JSON.stringify(request.body);
                    };
                }

                invokeMicroservices();
                function invokeMicroservices() {

                    var properties = _.extend(
                        _.pick(request.headers, ['host', 'dnt','authorization']),
                        _.pick(request, ['protocol', 'method', 'path', 'params', 'q', 'query', 'url']));
                    if (_.has(properties, 'url')) {
                        // log.fatal('DONOTCOMMITTHIS|', util.inspect(properties.url));
                        properties.url = properties.url.toString();
                    }

                    var rk = _.trim(request.path, '/').split('/')
                        .concat([request.method.toLowerCase()])
                        .join('.');
                    log.debug('%s %s |request| rk: %s', request.method, request.path, rk);
                    log.trace('%s %s |request| rk: %s, \nproperties:\n', request.method, request.path, rk, properties, '\nbody:\n', request.body);
                    properties['url'] = properties['url'].split('&').join('&amp;');

                    return callMicroservices(rk, request, properties, response);
                }
            });

            var server = app.listen(options.port, function() {
                var sa = server.address();
                log.info('Example app listening at http://%s:%s', sa.address, sa.port);
            });
        })
        .then(function() {
            if (options.enableLogAndReplyDebug) {
                return microservices.bind('api.#', function logAndReplyDebug(mc) {
                    log.debug('logAndReplyDebug| rk: %s, \nproperties:\n', mc.routingKey, mc.properties);
                    return {
                        messageContext: _.omit(mc, ['body']),
                        body: mc.deserialize(),
                    };
                });
            }
        });

    function callMicroservices(rk, request, properties, response) {

        return microservices.call(rk, request.body, properties)
            .then(function(mc) {
                if (mc.properties.contentType === 'application/json') {
                    var body = mc.deserialize();
                    var links = _.extend({}, transformLinks(mc.properties.links), _.get(body, '_links'));
                    body = _.extend({
                        _links: _.isEmpty(links) ? undefined : links,
                    }, _.omit(body, '_links'));
                }
                else {
                    body = mc.body;
                }
                var sc = parseInt(_.get(mc.properties, 'status.code') || _.get(body, 'status.code') || '');
                if (sc >= 400) {
                    response = response.status(sc);
                }

                if (sc >= 400) {
                    if (log.isTraceEnabled()) {
                        log.trace('%s %s |response| status: %s, rk: %s, \nproperties:\n', request.method, request.path, sc, mc.routingKey, mc.properties, '\nbody:\n', body);
                    }
                    else {
                        log.debug('%s %s |response| status: %s, rk: %s', request.method, request.path, sc, mc.routingKey);
                    }
                }

                return response.type(mc.properties.contentType).send(body);
            })
            .catch(Promise.TimeoutError, function(error) {
                log.warn('%s %s |timeout| rk: %s, error: TimeoutError', request.method, request.path, rk);
                return response.status(504).send({ errorType: 'TimeoutError', errorText: error.toString() });
            })
            .catch(function(error) {
                log.warn('%s %s |timeout| rk: %s, error:', request.method, request.path, rk, error);
                return response.status(500).send({ errorType: 'ServerError', errorText: error.toString() });
            });
    }

    function transformLinks(value) {
        if (_.isArray(value)) {
            return _.map(value, transformLinks);
        }
        else if (_.get(value, 'to')) {
            return _.defaults({ href: '/' + value.to.split('.').join('/') }, _.omit(value, ['href', 'to']));
        }
        else if (_.isPlainObject(value)) {
            return _.mapValues(value, transformLinks);
        }
        else {
            return value;
        }
    }
});
