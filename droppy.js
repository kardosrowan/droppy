#!/bin/env node
/* ----------------------------------------------------------------------------
                          droppy - file server on node
                      https://github.com/silverwind/droppy
 ------------------------------------------------------------------------------
 Copyright (c) 2012 - 2014 silverwind

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights
 to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:

 The above copyright notice and this permission notice shall be included in all
 copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 SOFTWARE.
 --------------------------------------------------------------------------- */
/*jslint evil: true, expr: true, regexdash: true, bitwise: true,
  trailing: false, sub: true, eqeqeq: true, forin: true, freeze: true,
  loopfunc: true, laxcomma: true, indent: false, white: true, nonew: true,
  newcap: true, undef: true, unused: true, globalstrict: true, node: true */
"use strict";

(function () {
    var
        // Libraries
        utils    = require("./lib/utils.js"),
        log      = require("./lib/log.js"),
        cfg      = require("./lib/config.js"),
        tpls     = require("./lib/dottemplates.js"),
        // Modules
        archiver = require("archiver"),
        async    = require("async"),
        ap       = require("autoprefixer"),
        Busboy   = require("busboy"),
        chalk    = require("chalk"),
        crypto   = require("crypto"),
        fs       = require("graceful-fs"),
        http     = require("http"),
        mime     = require("mime"),
        path     = require("path"),
        qs       = require("querystring"),
        util     = require("util"),
        Wss      = require("ws").Server,
        wrench   = require("wrench"),
        zlib     = require("zlib"),
        // Variables
        version  = require("./package.json").version,
        config   = null,
        cache    = {},
        clients  = {},
        db       = {},
        dirs     = {},
        watchers = {},
        cssCache = null,
        firstRun = null,
        mode     = {file: "644", dir: "755"},
        isCLI    = (process.argv.length > 2),
        // Resources
        cmPath    = "node_modules/codemirror/",
        templateList = ["directory.html", "document.html", "image.html"],
        resources = {
            css  : [cmPath + "lib/codemirror.css", "src/style.css", "src/sprites.css"],
            js   : ["node_modules/jquery/dist/jquery.js", "src/client.js", cmPath + "lib/codemirror.js"],
            html : ["src/base.html", "src/auth.html", "src/main.html"],
            templates : []
        };
    // Add Templates
    templateList.forEach(function (relPath) {
        resources.templates.push("src/templates/" + relPath);
    });

    // Add CodeMirror source paths
    // Addons
    ["selection/active-line.js", "selection/mark-selection.js", "search/searchcursor.js", "edit/matchbrackets.js"].forEach(function (relPath) {
        resources.js.push(cmPath + "addon/" + relPath);
    });
    // Modes
    ["css/css.js", "coffeescript/coffeescript.js", "javascript/javascript.js", "xml/xml.js", "htmlmixed/htmlmixed.js", "jade/jade.js",
     "markdown/markdown.js", "php/php.js"].forEach(function (relPath) {
        resources.js.push(cmPath + "mode/" + relPath);
    });
    // Keymaps
    // resources.js.push(cmPath + "keymap/sublime.js");
    // Themes
    ["xq-light.css", "base16-dark.css"].forEach(function (relPath) {
        resources.css.push(cmPath + "theme/" + relPath);
    });

    // Argument handler
    if (isCLI) handleArguments();

    config = cfg(path.join(process.cwd(), "config.json"));
    log.init(config);
    log.logo();
    fs.MAX_OPEN = config.maxOpen;
    log.useTimestamp = config.timestamps;

    log.simple(chalk.blue("droppy "), chalk.green(version), " running on ",
               chalk.blue("node "), chalk.green(process.version.substring(1)));

    // Read user/sessions from DB and check if its the first run
    readDB();
    firstRun = Object.keys(db.users).length < 1;

    // Copy/Minify JS, CSS and HTML content
    prepareContent();

    // Prepare to get up and running
    cacheResources(config.resDir, function () {
        setupDirectories();
        cleanupLinks();
        createListener();
    });

    //-----------------------------------------------------------------------------
    // Read JS/CSS/HTML client resources, minify them, and write them to /res
    function prepareContent() {
        var out = { css : "", js  : "" },
            compiledList = ["base.html", "auth.html", "main.html", "client.js", "style.css"],
            resourceList = utils.flatten(resources),
            matches = { resource: 0, compiled: 0 };
        //Prepare SVGs
        try {
            var svgDir = config.srcDir + "svg/", svgData = {};
            fs.readdirSync(config.srcDir + "svg/").forEach(function (name) {
                svgData[name.slice(0, name.length - 4)] = fs.readFileSync(path.join(svgDir, name), "utf8");
            });
            cache.svg = svgData;
        } catch (error) {
            log.error("Error processing SVGs: ", error);
            process.exit(1);
        }

        // Intialize the CSS cache when debugging
        if (config.debug) updateCSS();

        // Check if we to actually need to recompile resources
        resourceList.forEach(function (file) {
            try {
                if (crypto.createHash("md5").update(fs.readFileSync(file)).digest("base64") === db.resourceHashes[file])
                    matches.resource++;
                else return;
            } catch (error) { return; }
        });
        compiledList.forEach(function (file) {
            try {
                if (fs.statSync(getResPath(file)))
                    matches.compiled++;
                else return;
            } catch (error) { return; }
        });
        if (matches.resource === resourceList.length &&
            matches.compiled === compiledList.length &&
            db.resourceDebug !== undefined &&
            db.resourceDebug === config.debug) {
            return;
        }

        // Read resources
        var resourceData = {};
        for (var type in resources) {
            if (resources.hasOwnProperty(type)) {
                resourceData[type] = resources[type].map(function read(file) {
                    var data;
                    try {
                        data = fs.readFileSync(file).toString("utf8");
                    } catch (error) {
                        log.error("Error reading " + file + ":\n", error);
                        process.exit(1);
                    }
                    return data;
                });
            }
        }

        // Concatenate CSS and JS
        log.simple("Minifying resources...");
        resourceData.css.forEach(function (data) {
            out.css += data + "\n";
        });
        resourceData.js.forEach(function (data) {
            // Append a semicolon to each javascript file to make sure it's
            // properly terminated. The minifier afterwards will take care of
            // any double-semicolons and whitespace.
            out.js += data + ";\n";
        });

        out.js += "(function (){var t = {};";
        var index = 0;
        resourceData.templates.forEach(function (data) {
            // Produce the doT functions
            out.js += tpls.produceFunction("t." + templateList[index++].replace(/^(\w+)[\S\s]+$/, "$1"), data);
        });
        out.js += ";window.t = t;}());";

        // Add CSS vendor prefixes
        out.css = ap("last 2 versions").process(out.css).css;
        // Minify CSS
        out.css = new require("clean-css")({keepSpecialComments : 0}).minify(out.css);
        // Minify JS
        if (!config.debug)
            out.js = require("uglify-js").minify(out.js, {
                fromString: true,
                compress: {
                    unsafe: true,
                    screw_ie8: true
                }
            }).code;

        // Prepare HTML
        try {
            var index = 0;
            resourceData.html.forEach(function (data) {
                var name = path.basename(resources.html[index]);
                // Minify HTML by removing tabs, CRs and LFs
                fs.writeFileSync(getResPath(path.basename(name)), data.replace(/\n^\s*/gm, "").replace("{{version}}", version));
                index++;
            });
            fs.writeFileSync(getResPath("client.js"), out.js);
            fs.writeFileSync(getResPath("style.css"), out.css);
        } catch (error) {
            log.error("Error writing resources:\n", error);
            process.exit(1);
        }

        // Save the hashes of all compiled files
        resourceList.forEach(function (file) {
            if (!db.resourceHashes) db.resourceHashes = {};
            db.resourceHashes[file] = crypto.createHash("md5").update(fs.readFileSync(file)).digest("base64");
            db.resourceDebug = config.debug; // Save the state of the last resource compilation
        });
        writeDB();
    }

    //-----------------------------------------------------------------------------
    // Set up the directory
    function setupDirectories() {
        cleanupTemp(true);
        try {
            wrench.mkdirSyncRecursive(config.filesDir, mode.dir);
            wrench.mkdirSyncRecursive(config.incomingDir, mode.dir);
        } catch (error) {
            log.simple("Unable to create directories:");
            log.error(error);
            process.exit(1);
        }
    }

    //-----------------------------------------------------------------------------
    // Clean up the directory for incoming files
    function cleanupTemp(initial) {
        try {
            wrench.rmdirSyncRecursive(config.incomingDir, true);
        } catch (error) {
            if (initial) {
                log.simple("Error cleaning up temporary directories:");
                log.error(error);
                process.exit(1);
            }
        }
    }

    //-----------------------------------------------------------------------------
    // Clean up our shortened links by removing links to nonexistant files
    function cleanupLinks() {
        var linkcount = 0, cbcount = 0;
        for (var link in db.shortlinks) {
            if (db.shortlinks.hasOwnProperty(link)) {
                linkcount++;
                (function (shortlink, location) {
                    fs.stat(path.join(config.filesDir, location), function (error, stats) {
                        cbcount++;
                        if (!stats || error) {
                            delete db.shortlinks[shortlink];
                        }
                        if (cbcount === linkcount) {
                            writeDB();
                        }
                    });
                })(link, db.shortlinks[link]);
            }
        }
    }

    //-----------------------------------------------------------------------------
    // Bind to listening port
    function createListener() {
        var server, key, cert, ca;
        if (!config.useTLS) {
            server = http.createServer(onRequest);
        } else {
            try {
                key = fs.readFileSync(config.tls.key);
                cert = fs.readFileSync(config.tls.cert);
                if (config.tls.ca.length) {
                    if (Array.isArray(config.tls.ca))
                        ca = config.tls.ca;
                    else if (typeof config.tls.ca === "string")
                        ca = [config.tls.ca];
                    ca = ca.map(function read(file) { return fs.readFileSync(file); });
                }
            } catch (error) {
                log.error("Couldn't read required TLS keys or certificates. See `tls` section of config.json.\n\n", util.inspect(error));
                process.exit(1);
            }

            var mod = config.useSPDY ? require("spdy").server : require("tls");

            // TLS options
            // TODO: Harden the cipher suite
            var options = {
                key              : key,
                cert             : cert,
                ca               : ca,
                honorCipherOrder : true,
                ciphers          : "ECDHE-RSA-AES256-SHA:AES256-SHA:RC4-SHA:RC4:HIGH:!MD5:!aNULL:!EDH:!AESGCM",
                secureProtocol   : "SSLv23_server_method",
                NPNProtocols     : []
            };

            mod.CLIENT_RENEG_LIMIT = 0; // No client renegotiation

            // Protocol-specific options
            if (config.useSPDY) options.windowSize = 1024 * 1024;

            server = new mod.Server(options, http._connectionListener);
            server.httpAllowHalfOpen = false;
            server.timeout = 120000;

            server.on("request", function (req, res) {
                if (config.useHSTS)
                    res.setHeader("Strict-Transport-Security", "max-age=31536000");
                onRequest(req, res);
            });

            server.on("clientError", function (err, conn) {
                conn.destroy();
            });

            // TLS session resumption
            var sessions = {};

            server.on("newSession", function (id, data) {
                sessions[id] = data;
            });

            server.on("resumeSession", function (id, callback) {
                callback(null, (id in sessions) ? sessions[id] : null);
            });
        }

        server.on("listening", function () {
            setupSocket(server);
            if (config.debug) watchCSS();
            log.simple("Listening on ", chalk.cyan(server.address().address),
                       ":", chalk.blue(server.address().port));
        });

        server.on("error", function (error) {
            if (error.code === "EADDRINUSE")
                log.simple("Failed to bind to ", chalk.cyan(config.listenHost), chalk.red(":"),
                          chalk.blue(config.listenPort), chalk.red(". Address already in use.\n"));
            else if (error.code === "EACCES")
                log.simple("Failed to bind to ", chalk.cyan(config.listenHost), chalk.red(":"),
                          chalk.blue(config.listenPort), chalk.red(". Need permission to bind to ports < 1024.\n"));
            else
                log.error(error);
            process.exit(1);
        });

        server.listen(config.listenPort, (process.env.NODE_ENV === "production") ? process.env.PORT : config.listenPort);
    }

    //-----------------------------------------------------------------------------
    // GET/POST handler
    function onRequest(req, res) {
        switch (req.method.toUpperCase()) {
        case "GET":
            handleGET(req, res);
            break;
        case "POST":
            handlePOST(req, res);
            break;
        case "OPTIONS":
            res.setHeader("Allow", "GET,POST,OPTIONS");
            res.end("\n");
            log.info(req, res);
            break;
        default:
            res.statusCode = 405;
            res.end("\n");
            log.info(req, res);
        }
    }

    //-----------------------------------------------------------------------------
    // WebSocket functions
    function setupSocket(server) {
        var wss = new Wss({server : server});
        if (config.keepAlive > 0) {
            setInterval(function () {
                for (var client in wss.clients)
                    if (wss.clients.hasOwnProperty(client))
                        wss.clients[client].send("ping");
            }, config.keepAlive);
        }
        wss.on("connection", function (ws) {
            var cookie = getCookie(ws.upgradeReq.headers.cookie),
                client;

            if (!cookie && !config.noLogin) {
                ws.close(4000);
                log.info(ws, null, "Unauthorized WebSocket connection closed.");
                return;
            } else {
                log.info(ws, null, "WebSocket [", chalk.green("connected"), "] ");
                clients[cookie] = { v: [], ws: ws };
                client = clients[cookie];
            }
            ws.on("message", function (message) {
                if (message === "pong") return;
                var msg = JSON.parse(message),
                    vId = msg.vId;

                log.debug(ws, null, chalk.magenta("RECV "), message);
                switch (msg.type) {
                case "REQUEST_SETTINGS":
                    send(client.ws, JSON.stringify({ type : "SETTINGS", vId : vId, settings: {
                        debug: config.debug,
                        demoMode: config.demoMode
                    }}));
                    break;
                case "REQUEST_UPDATE":
                    if (!utils.isPathSane(msg.data)) return log.info(ws, null, "Invalid update request: " + msg.data);
                    if (!client.v[vId]) client.v[vId] = {}; // This can happen when the server restarts
                    readPath(msg.data, function (error, info) {
                        if (error) {
                            return log.info(ws, null, "Non-existing update request: " + msg.data);
                        } else if (info.type === "f") {
                            client.v[vId].file = path.basename(msg.data);
                            client.v[vId].directory = path.dirname(msg.data);
                            info.folder = path.dirname(msg.data);
                            info.file = path.basename(msg.data);
                            info.isFile = true;
                            info.vId = vId;
                            info.type = "UPDATE_BE_FILE";
                            send(client.ws, JSON.stringify(info));
                        } else {
                            client.v[vId].file = null;
                            client.v[vId].directory = msg.data;
                            updateDirectory(client.v[vId].directory, function (sizes) {
                                sendFiles(cookie, vId, "UPDATE_DIRECTORY", sizes);
                            });
                            updateWatchers(client.v[vId].directory);
                        }
                    });
                    break;
                case "NEW_VIEW":
                    client.v[vId] = {};
                    break;
                case "DESTROY_VIEW":
                    checkWatchedDirs();
                    delete client.v[vId];
                    break;
                case "REQUEST_SHORTLINK":
                    if (!utils.isPathSane(msg.data)) return log.info(ws, null, "Invalid shortlink request: " + msg.data);
                    // Check if we already have a link for that file
                    for (var link in db.shortlinks) {
                        if (db.shortlinks[link] === msg.data) {
                            sendLink(cookie, link);
                            return;
                        }
                    }
                    // Get a pseudo-random n-character lowercase string. The characters
                    // "l", "1", "i", o", "0" characters are skipped for easier communication of links.
                    var chars = "abcdefghjkmnpqrstuvwxyz23456789";
                    do {
                        link = "";
                        while (link.length < config.linkLength)
                            link += chars.charAt(Math.floor(Math.random() * chars.length));
                    } while (db.shortlinks[link]); // In case the RNG generates an existing link, go again
                    log.info(ws, null, "Shortlink created: " + link + " -> " + msg.data);
                    db.shortlinks[link] = msg.data;
                    sendLink(cookie, link);
                    writeDB();
                    break;
                case "DELETE_FILE":
                    log.info(ws, null, "Deleting: " + msg.data.substring(1));
                    if (!utils.isPathSane(msg.data)) return log.info(ws, null, "Invalid file deletion request: " + msg.data);
                    msg.data = addFilePath(msg.data);
                    fs.stat(msg.data, function (error, stats) {
                        if (error) {
                            log.error("Error getting stats to delete " + msg.data);
                            log.error(error);
                        } else if (stats) {
                            if (stats.isFile())
                                deleteFile(msg.data);
                            else if (stats.isDirectory())
                                deleteDirectory(msg.data);
                        }
                    });
                    break;
                case "SAVE_FILE":
                    log.info(ws, null, "Saving: " + msg.data.to.substring(1));
                    if (!utils.isPathSane(msg.data.to)) return log.info(ws, null, "Invalid save request: " + msg.data);
                    msg.data.to = addFilePath(msg.data.to);
                    fs.stat(msg.data.to, function (error, stats) {
                        if (error) {
                            log.error("Error getting stats to save " + msg.data.to);
                            log.error(error);
                        } else if (stats) {
                            if (stats.isFile()) {
                                // TODO: Check if user has permission
                                fs.writeFile(msg.data.to, msg.data.value, function (error) {
                                    if (error) {
                                        log.error("Error writing " + msg.data.to);
                                        log.error(error);
                                        sendSaveStatus(cookie, vId, 1); // Save failed
                                    } else {
                                        sendSaveStatus(cookie, vId, 0); // Save successful
                                    }
                                });
                            }
                        }
                    });
                    break;
                case "CLIPBOARD":
                    log.info(ws, null, msg.data.type + ": " + msg.data.from + " -> " + msg.data.to);
                    if (!utils.isPathSane(msg.data.from)) return log.info(ws, null, "Invalid clipboard source: " + msg.data.from);
                    if (!utils.isPathSane(msg.data.to)) return log.info(ws, null, "Invalid clipboard destination: " + msg.data.to);
                    if (msg.data.to.indexOf(msg.data.from) !== -1 && msg.data.to !== msg.data.from) {
                        log.error("Can't copy directory into itself");
                        send(client.ws, JSON.stringify({ vId: vId, type : "ERROR", text: "Can't copy directory into itself."}));
                        return;
                    }
                    msg.data.from = addFilePath(msg.data.from);
                    msg.data.to = addFilePath(msg.data.to);

                    // In case source and destination are the same, append a number to the file/foldername
                    if (msg.data.from === msg.data.to) {
                        utils.getNewPath(msg.data.to, 2, function (name) {
                            doClipboard(msg.data.type, msg.data.from, path.join(path.dirname(msg.data.to), path.basename(name)));
                        });
                    } else {
                        doClipboard(msg.data.type, msg.data.from, msg.data.to);
                    }
                    break;
                case "CREATE_FOLDER":
                    if (!utils.isPathSane(msg.data)) return log.info(ws, null, "Invalid directory creation request: " + msg.data);
                    fs.mkdir(addFilePath(msg.data), mode.dir, function (error) {
                        if (error) log.error(error);
                        log.info(ws, null, "Created: ", msg.data);
                    });
                    break;
                case "RENAME":
                    // Disallow whitespace-only and empty strings in renames
                    if (!utils.isPathSane(msg.data.new) || /^\s*$/.test(msg.data.to) || msg.data.to === "") {
                        log.info(ws, null, "Invalid rename request: " + msg.data.new);
                        send(client.ws, JSON.stringify({ type : "ERROR", text: "Invalid rename request"}));
                        return;
                    }
                    fs.rename(addFilePath(msg.data.old), addFilePath(msg.data.new), function (error) {
                        if (error) log.error(error);
                        log.info(ws, null, "Renamed: ", msg.data.old, " -> ", msg.data.new);
                    });
                    break;
                case "GET_USERS":
                    if (!db.sessions[cookie].privileged) return;
                    sendUsers(cookie);
                    break;
                case "UPDATE_USER":
                    var name = msg.data.name, pass = msg.data.pass, priv = msg.data.priv;
                    if (!db.sessions[cookie].privileged) return;
                    if (pass === "") {
                        if (!db.users[name]) return;
                        delUser(msg.data.name);
                        log.info(ws, null, "Deleted user: ", chalk.magenta(name));
                        sendUsers(cookie);
                    } else {
                        var isNew = !db.users[name];
                        addOrUpdateUser(name, pass, priv);
                        if (isNew)
                            log.info(ws, null, "Added user: ", chalk.magenta(name));
                        else
                            log.info(ws, null, "Updated user: ", chalk.magenta(name));
                        sendUsers(cookie);
                    }
                    break;
                case "ZERO_FILES":
                    msg.data.forEach(function (file) {
                        if (!utils.isPathSane(file)) return log.info(ws, null, "Invalid empty file creation request: " + file);
                        wrench.mkdirSyncRecursive(path.dirname(addFilePath(file)), mode.dir);
                        fs.writeFileSync(addFilePath(file), "", {mode: mode.file});
                        log.info(ws, null, "Received: " + file.substring(1));
                    });
                    send(client.ws, JSON.stringify({ type : "UPLOAD_DONE", vId : vId }));
                    break;
                }
            });

            ws.on("close", function (code) {
                var reason;
                if (code === 4001) {
                    reason = "(Logged out)";
                    delete db.sessions[cookie];
                    writeDB();
                } else if (code === 1001) {
                    reason = "(Going away)";
                    delete clients[cookie];
                }
               log.info(ws, null, "WebSocket [", chalk.red("disconnected"), "] ", reason || "(Code: " + (code || "none")  + ")");
            });

            ws.on("error", function (error) {
                log.error(error);
            });
        });
    }

    //-----------------------------------------------------------------------------
    // Send a file list update
    var updateFuncs = {};
    function sendFiles(cookie, viewId, eventType, sizes) {
        if (!clients[cookie] || !clients[cookie].ws || !clients[cookie].ws._socket) return;
        var func = function (cookie, eventType, vId, sizes) {
            var dir = clients[cookie].v[vId].directory,
                data = {
                    vId    : vId,
                    type   : eventType,
                    folder : dir,
                    data   : dirs[dir]
                };
            if (sizes) data.sizes = true;
            data = JSON.stringify(data);
            send(clients[cookie].ws, data);
        };

        if (!updateFuncs[cookie])
            updateFuncs[cookie] = utils.throttle(func, 250, { leading: true, trailing: false });

        if (!sizes)
            updateFuncs[cookie](cookie, eventType, viewId, sizes);
        else
            func(cookie, eventType, viewId, sizes);
    }

    //-----------------------------------------------------------------------------
    // Send a file link to a client
    function sendLink(cookie, link) {
        if (!clients[cookie] || !clients[cookie].ws) return;
        send(clients[cookie].ws, JSON.stringify({
            type : "SHORTLINK",
            link : link
        }));
    }

    //-----------------------------------------------------------------------------
    // Send a list of users on the server
    function sendUsers(cookie) {
        if (!clients[cookie] || !clients[cookie].ws) return;
        var userlist = {};
        for (var user in db.users) {
            if (db.users.hasOwnProperty(user)) {
                userlist[user] = db.users[user].privileged || false;
            }
        }
        send(clients[cookie].ws, JSON.stringify({
            type  : "USER_LIST",
            users : userlist
        }));
    }

    //-----------------------------------------------------------------------------
    // Send status of a file save
    function sendSaveStatus(cookie, vId, status) {
        if (!clients[cookie] || !clients[cookie].ws) return;
        send(clients[cookie].ws, JSON.stringify({
            type   : "SAVE_STATUS",
            vId    : vId,
            status : status
        }));
    }

    //-----------------------------------------------------------------------------
    // Do the actual sending
    function send(ws, data) {
        (function queue(ws, data, time) {
            if (time > 1000) return; // in case the socket hasn't opened after 1 second, cancel the sending
            if (ws && ws.readyState === 1) {
                log.debug(ws, null, chalk.green("SEND "), data);
                ws.send(data, function (error) {
                    if (error) log.error(error);
                });
            } else {
                setTimeout(queue, 50, ws, data, time + 50);
            }
        })(ws, data, 0);
    }
    //-----------------------------------------------------------------------------
    // Perform clipboard operation, copy/paste or cut/paste
    function doClipboard(type, from, to) {
        fs.stat(from, function (error, stats) {
            if (stats && !error) {
                if (stats.isFile()) {
                    copyFile(from, to, function (error) {
                        if (error) {
                            log.error("Error copying single file from \"" + from + "\" to \"" + to + "\"");
                            log.error(error);
                        } else {
                            if (type === "cut") {
                                deleteFile(from);
                            }
                        }
                    });
                } else if (stats.isDirectory()) {
                    wrench.copyDirRecursive(from, to, {forceDelete: true, preserveTimestamps: true}, function(){
                        if (type === "cut") {
                            deleteDirectory(from);
                        }
                    });
                }
            }
        });
    }
    //-----------------------------------------------------------------------------
    // Copy a file from one location to another quickly
    // snippet from: http://stackoverflow.com/a/14387791/2096729
    function copyFile(source, target, cb) {
        var cbCalled = false;

        var rd = fs.createReadStream(source);
        rd.on("error", function (err) {
            done(err);
        });
        var wr = fs.createWriteStream(target);
        wr.on("error", function (err) {
            done(err);
        });
        wr.on("close", function () {
            done();
        });
        rd.pipe(wr);

        function done(err) {
            if (!cbCalled) {
                cb(err);
                cbCalled = true;
            }
        }
    }

    //-----------------------------------------------------------------------------
    // Delete a file
    function deleteFile(file) {
        fs.unlink(file, function (error) {
            if (error) log.error(error);
        });
    }

    //-----------------------------------------------------------------------------
    // Delete a directory recursively
    function deleteDirectory(directory) {
        try {
            wrench.rmdirSyncRecursive(directory);
            checkWatchedDirs();
        } catch (error) {
            // Specifically log this error as it possibly has to do with
            // wrench not using graceful-fs
            log.error("Error applying wrench.rmdirSyncRecursive");
            log.error(error);
        }
    }

    //-----------------------------------------------------------------------------
    // Watch the directory for changes and send them to the appropriate clients.
    function createWatcher(directory) {
        var relativeDir = removeFilePath(directory);
        var watcher = fs.watch(directory, utils.throttle(function () {
            var clientsToUpdate = [];
            for (var cookie in clients) {
                if (clients.hasOwnProperty(cookie)) {
                    var client = clients[cookie];
                    for (var vId = client.v.length - 1; vId >= 0; vId--) {
                        if (client.v[vId].directory === relativeDir && client.v[vId].file === null) {
                            clientsToUpdate.push({cookie: cookie, vId: vId});
                        }
                    }
                }
            }
            updateDirectory(relativeDir, function (sizes) {
                if (clientsToUpdate.length === 0) return;
                var client = clientsToUpdate.pop();
                sendFiles(client.cookie, client.vId, "UPDATE_DIRECTORY", sizes);
                if (!sizes) clientsToUpdate.push(client);
            });
        }, config.readInterval));
        watcher.on("error", function (error) {
            log.error("Error trying to watch ", relativeDir, "\n", error);
        });
        watchers[relativeDir] = watcher;
    }

    //-----------------------------------------------------------------------------
    // Watch given directory
    function updateWatchers(newDir, callback) {
        if (!watchers[newDir]) {
            newDir = addFilePath(newDir);
            fs.stat(newDir, function (error, stats) {
                if (error || !stats) {
                    // Requested Directory can't be read
                    checkWatchedDirs();
                    if (callback) callback(false);
                } else {
                    // Directory is okay to be read
                    createWatcher(newDir);
                    checkWatchedDirs();
                    if (callback) callback(true);
                }
            });
        } else {
            if (callback) callback(true);
        }
    }

    //-----------------------------------------------------------------------------
    // Check if we need the other active watchers
    function checkWatchedDirs() {
        var neededDirs = {};
        for (var cookie in clients) {
            if (clients.hasOwnProperty(cookie)) {
                var client = clients[cookie];
                for (var vId = client.v.length - 1; vId >= 0; vId--) {
                    if (client.v[vId] && client.v[vId].file === null) {
                        neededDirs[client.v[vId].directory] = true;
                    }
                }
            }
        }
        for (var directory in watchers) {
            if (!neededDirs[directory]) {
                watchers[directory].close();
                delete watchers[directory];
            }
        }
    }

    //-----------------------------------------------------------------------------
    // Read resources and store them in the cache object
    function cacheResources(dir, callback) {
        var gzipFiles, relPath, fileName, fileData, fileTime;
        cache.res = {};

        dir = dir.substring(0, dir.length - 1); // Strip trailing slash
        utils.walkDirectory(dir, false, function (error, results) {
            if (error) log.error(error);
            gzipFiles = [];
            results.forEach(function (fullPath) {
                relPath = fullPath.substring(dir.length + 1);
                fileName = path.basename(fullPath);

                try {
                    fileData = fs.readFileSync(fullPath);
                    fileTime = fs.statSync(fullPath).mtime;
                } catch (error) {
                    log.error(error);
                }

                cache.res[relPath] = {};
                cache.res[relPath].data = fileData;
                cache.res[relPath].etag = crypto.createHash("md5").update(String(fileTime)).digest("hex");
                cache.res[relPath].mime = mime.lookup(fullPath);
                if (/.*(js|css|html|svg)$/.test(fileName)) {
                    gzipFiles.push(relPath);
                }
            });

            if (gzipFiles.length > 0)
                runGzip();
            else
                callback();

            function runGzip() {
                var currentFile = gzipFiles[0];
                zlib.gzip(cache.res[currentFile].data, function (error, compressedData) {
                    if (error) log.error(error);
                    cache.res[currentFile].gzipData = compressedData;
                    gzipFiles = gzipFiles.slice(1);
                    if (gzipFiles.length > 0)
                        runGzip();
                    else
                        callback();
                });
            }
        });
    }
    //-----------------------------------------------------------------------------
    function handleGET(req, res) {
        var URI = decodeURIComponent(req.url), isAuth = false;
        req.time = Date.now();

        if (config.noLogin && !getCookie(req.headers.cookie)) freeCookie(req, res);
        if (getCookie(req.headers.cookie) || config.noLogin)
            isAuth = true;

        if (URI === "/") {
            handleResourceRequest(req, res, "base.html");
        } else if (/^\/!\/content/.test(URI)) {
            if (isAuth) {
                res.setHeader("X-Page-Type", "main");
                handleResourceRequest(req, res, "main.html");
            } else if (firstRun) {
                res.setHeader("X-Page-Type", "firstrun");
                handleResourceRequest(req, res, "auth.html");
            } else {
                res.setHeader("X-Page-Type", "auth");
                handleResourceRequest(req, res, "auth.html");
            }
        } else if (/^\/!\/svg/.test(URI)) {
            var json = JSON.stringify(cache.svg);
            res.statusCode = 200;
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.setHeader("Content-Length", json.length);
            res.end(json);
            log.info(req, res);
        } else if (/^\/!\/null/.test(URI)) {
            res.statusCode = 200;
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.setHeader("Content-Length", 0);
            res.end();
            log.info(req, res);
            return;
        } else if (/^\/!\//.test(URI)) {
            handleResourceRequest(req, res, req.url.substring(3));
        } else if (/^\/~\//.test(URI) || /^\/\$\//.test(URI)) {
            handleFileRequest(req, res, true);
        } else if (/^\/_\//.test(URI) || /^\/\$\//.test(URI)) {
            handleFileRequest(req, res, false);
        } else if (/^\/~~\//.test(URI)) {
            streamArchive(req, res, "zip");
        } else if (URI === "/favicon.ico") {
            handleResourceRequest(req, res, "favicon.ico");
        } else {
            if (!isAuth) {
                res.statusCode = 301;
                res.setHeader("Location", "/");
                res.end();
                log.info(req, res);
                return;
            }

            // Check if client is going to a path directly
            fs.stat(path.join(config.filesDir, URI), function (error) {
                if (!error) {
                    handleResourceRequest(req, res, "base.html");
                } else {
                    log.error(error);
                    res.statusCode = 301;
                    res.setHeader("Location", "/");
                    res.end();
                    log.info(req, res);
                }
            });
        }
    }

    //-----------------------------------------------------------------------------
    var blocked = [];
    function handlePOST(req, res) {
        var URI = decodeURIComponent(req.url), body = "";
        if (/^\/upload/.test(URI)) {
            if (!getCookie(req.headers.cookie)) {
                res.statusCode = 401;
                res.end();
                log.info(req, res);
            }
            handleUploadRequest(req, res);
        } else if (URI === "/login") {
            // Throttle login attempts to 1 per second
            if (blocked.indexOf(req.socket.remoteAddress) >= 0) {
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.end();
                return;
            }
            blocked.push(req.socket.remoteAddress);
            (function (ip) {
                setTimeout(function () {
                    blocked.pop(ip);
                }, 1000);
            })(req.socket.remoteAddress);

            req.on("data", function (data) { body += data; });
            req.on("end", function () {
                var postData = qs.parse(body);
                if (isValidUser(postData.username, postData.password)) {
                    createCookie(req, res, postData);
                    endReq(req, res, true);
                    log.info(req, res, "User ", postData.username, chalk.green(" authenticated"));
                } else {
                    endReq(req, res, false);
                    log.info(req, res, "User ", postData.username, chalk.red(" unauthorized"));
                }
            });
        } else if (URI === "/adduser" && firstRun) {
            req.on("data", function (data) { body += data; });
            req.on("end", function () {
                var postData = qs.parse(body);
                if (postData.username !== "" && postData.password !== "") {
                    addOrUpdateUser(postData.username, postData.password, true);
                    createCookie(req, res, postData);
                    firstRun = false;
                    endReq(req, res, true);
                } else {
                    endReq(req, res, false);
                }
            });
        } else {
            res.statusCode = 404;
            res.end();
        }

        function endReq(req, res, success) {
            res.statusCode = success ? 202 : 401;
            res.setHeader("Content-Type", "text/plain");
            res.setHeader("Content-Length", 0);
            res.end();
            log.info(req, res);
        }
    }

    //-----------------------------------------------------------------------------
    function handleResourceRequest(req, res, resourceName) {

        // Shortcut for CSS debugging when no Websocket is available
        if (config.debug && resourceName === "style.css") {
            res.statusCode = 200;
            res.setHeader("Content-Type", "text/css; charset=utf-8");
            res.setHeader("Cache-Control", "private, no-cache, no-transform, no-store");
            res.setHeader("Content-Length", Buffer.byteLength(cssCache, "utf8"));
            res.end(cssCache);
            log.info(req, res);
            return;
        }

        // Regular resource handling
        if (cache.res[resourceName] === undefined) {
            res.statusCode = 404;
            res.end();
        } else {
            if ((req.headers["if-none-match"] || "") === cache.res[resourceName].etag) {
                res.statusCode = 304;
                res.end();
            } else {
                res.statusCode = 200;

                // Disallow framing except when debugging
                if (!config.debug) res.setHeader("X-Frame-Options", "DENY");

                if (req.url === "/") {
                    // Set the IE10 compatibility mode
                    if (req.headers["user-agent"] && req.headers["user-agent"].indexOf("MSIE") > 0)
                        res.setHeader("X-UA-Compatible", "IE=Edge, chrome=1");
                } else if (/^\/content\//.test(req.url)) {
                    // Don't ever cache /content since its data is dynamic
                    res.setHeader("Cache-Control", "private, no-cache, no-transform, no-store");
                } else if (resourceName === "favicon.ico") {
                    // Set a long cache on the favicon, as some browsers seem to request them constantly
                    res.setHeader("Cache-Control", "max-age=7257600");
                } else {
                    // All other content can be cached
                    res.setHeader("ETag", cache.res[resourceName].etag);
                }

                if (/.*(js|css|html|svg)$/.test(resourceName))
                    res.setHeader("Content-Type", cache.res[resourceName].mime + "; charset=utf-8");
                else
                    res.setHeader("Content-Type", cache.res[resourceName].mime);

                var acceptEncoding = req.headers["accept-encoding"] || "";
                if (/\bgzip\b/.test(acceptEncoding) && cache.res[resourceName].gzipData !== undefined) {
                    res.setHeader("Content-Encoding", "gzip");
                    res.setHeader("Content-Length", cache.res[resourceName].gzipData.length);
                    res.setHeader("Vary", "Accept-Encoding");
                    res.end(cache.res[resourceName].gzipData);
                } else {
                    res.setHeader("Content-Length", cache.res[resourceName].data.length);
                    res.end(cache.res[resourceName].data);
                }
            }
        }
        log.info(req, res);
    }

    //-----------------------------------------------------------------------------
    function handleFileRequest(req, res, download) {
        var URI = decodeURIComponent(req.url).substring(3), shortLink, dispo, filepath;

        // Check for a shortlink
        if (/^\/\$\//.test(req.url) && db.shortlinks[URI] && URI.length  === config.linkLength)
            shortLink = db.shortlinks[URI];

        // Validate the cookie for the remaining requests
        if (!getCookie(req.headers.cookie) && !shortLink) {
            res.statusCode = 301;
            res.setHeader("Location", "/");
            res.end();
            log.info(req, res);
            return;
        }

        filepath = shortLink ? addFilePath(shortLink) : addFilePath("/" + URI);

        if (filepath) {
            var mimeType = mime.lookup(filepath);

            fs.stat(filepath, function (error, stats) {
                if (!error && stats) {
                    res.statusCode = 200;
                    if (download) {
                        if (shortLink) {
                            // IE 10/11 can't handle an UTF-8 Content-Dispotsition header, so we encode it
                            if (req.headers["user-agent"] && req.headers["user-agent"].indexOf("MSIE") > 0)
                                dispo = ['attachment; filename="', encodeURIComponent(path.basename(filepath)), '"'].join("");
                            else
                                dispo = ['attachment; filename="', path.basename(filepath), '"'].join("");
                        } else {
                            dispo = "attachment";
                        }
                        res.setHeader("Content-Disposition", dispo);
                    }
                    res.setHeader("Content-Type", mimeType);
                    res.setHeader("Content-Length", stats.size);
                    log.info(req, res);
                    fs.createReadStream(filepath, {bufferSize: 4096}).pipe(res);
                } else {
                    if (error.code === "ENOENT")
                        res.statusCode = 404;
                    else if (error.code === "EACCES")
                        res.statusCode = 403;
                    else
                        res.statusCode = 500;
                    res.end();
                    log.info(req, res);
                    if (error)
                        log.error(error);
                }
            });
        }
    }

    //-----------------------------------------------------------------------------
    function handleUploadRequest(req, res) {
        var cookie = getCookie(req.headers.cookie);

        req.query = qs.parse(req.url.substring("/upload?".length));
        log.info(req, res, "Upload started");

        // FEATURE: Check permissions
        if (!clients[cookie] && !config.noLogin) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "text/plain");
            res.end();
            log.info(req, res);
            return;
        }

        var busboy = new Busboy({ headers: req.headers, fileHwm: 1024 * 1024 }),
            done = false,
            files = [];

        busboy.on("file", function (fieldname, file, filename) {
            var dstRelative = filename ? decodeURIComponent(filename) : fieldname,
                dst = path.join(config.filesDir, req.query.to, dstRelative),
                tmp = path.join(config.incomingDir, crypto.createHash("md5").update(String(dst)).digest("hex"));

            files[dstRelative] = {
                src: tmp,
                dst: decodeURIComponent(dst)
            };
            file.pipe(fs.createWriteStream(tmp, { mode: mode.file}));
        });

        busboy.on("finish", function () {
            done = true;
            var names = Object.keys(files);
            while (names.length > 0) {
                (function (name) {
                    wrench.mkdirSyncRecursive(path.dirname(files[name].dst), mode.dir);
                    fs.rename(files[name].src, files[name].dst, function () {
                        log.info(req, res, "Received: " + decodeURIComponent(req.query.to) + "/" + name);
                    });
                })(names.pop());
            }
            closeConnection();
        });

        req.on("close", function () {
            if (!done) log.info(req, res, "Upload cancelled");
            closeConnection();
        });

        req.pipe(busboy);

        function closeConnection() {
            res.statusCode = 200;
            res.setHeader("Content-Type", "text/plain");
            res.setHeader("Connection", "close");
            res.end();
            send(clients[cookie].ws, JSON.stringify({ type : "UPLOAD_DONE", vId : req.query.vId }));
        }
    }

    //-----------------------------------------------------------------------------
    // Read a path, return type and info
    // @callback : function (error, info)
    function readPath(root, callback) {
        fs.stat(addFilePath(root), function (error, stats) {
            if (error) {
                callback(error);
            } else if (stats.isFile()) {
                callback(null, {
                    type: "f",
                    size: stats.size,
                    mtime: stats.mtime.getTime() || 0,
                    mime: mime.lookup(path.basename(root))
                });
            } else if (stats.isDirectory()) {
                callback(null, {
                    type: "d",
                    size: 0,
                    mtime: stats.mtime.getTime() || 0
                });
            } else {
                callback(new Error("Path neither directory or file!"));
            }
        });
    }
    //-----------------------------------------------------------------------------
    // Update a directory's content
    function updateDirectory(root, callback) {
        fs.readdir(addFilePath(root), function (error, files) {
            var dirContents = {}, done = 0, last;
            if (error) log.error(error);

            if (!files || files.length === 0) {
                dirs[root] = dirContents;
                callback();
            }
            last = files.length;

            for (var i = 0 ; i < last; i++) {
                (function (entry) {
                    readPath(root + "/" + entry, function (error, info) {
                        if (error) {
                            log.error(error);
                            callback();
                        } else {
                            dirContents[entry] = info;
                            if (++done === last) {
                                dirs[root] = dirContents;
                                callback();
                                generateDirSizes(root, dirContents, callback);
                            }
                        }
                    });
                })(files[i]);
            }
        });
    }

    function generateDirSizes(root, dirContents, callback) {
        var tmpDirs = [];
        Object.keys(dirContents).forEach(function (dir) {
            if (dirContents[dir].type === "d") tmpDirs.push(addFilePath(root + "/" + dir));
        });
        if (tmpDirs.length === 0) return;

        async.map(tmpDirs, du, function (err, results) {
            for (var i = 0, l = results.length; i < l; i++)
                dirs[root][path.basename(tmpDirs[i])].size = results[i];
            callback(true);
        });
    }

    //-----------------------------------------------------------------------------
    // Get a directory's size (the sum of all files inside it)
    // TODO: caching of results
    function du(dir, callback) {
        fs.stat(dir, function (error, stat) {
            if (error) { return callback(error); }
            if (!stat) return callback(null, 0);
            if (!stat.isDirectory()) return callback(null, stat.size);
            fs.readdir(dir, function (error, list) {
                if (error) return callback(error);
                async.map(list.map(function (f) { return path.join(dir, f); }), function (f, callback) { return du(f, callback); },
                    function (error, sizes) {
                        callback(error, sizes && sizes.reduce(function (p, s) {
                            return p + s;
                        }, stat.size));
                    }
                );
            });
        });
    }

    //-----------------------------------------------------------------------------
    // Create a zip file from a directory and stream it to a client
    function streamArchive(req, res, type) {
        var zipPath = addFilePath(decodeURIComponent(req.url.substring(4))), archive, paths, next;
        fs.stat(zipPath, function (err, stats) {
            if (err) {
                log.error(err);
            } else if (stats.isDirectory()) {
                res.statusCode = 200;
                res.setHeader("Content-Type", mime.lookup(type));

                if (req.headers["user-agent"] && req.headers["user-agent"].indexOf("MSIE") > 0)
                    res.setHeader("Content-Disposition", 'attachment; filename="' + encodeURIComponent(path.basename(zipPath)) + '.zip"');
                else
                    res.setHeader("Content-Disposition", 'attachment; filename="' + path.basename(zipPath) + '.zip"');

                res.setHeader("Transfer-Encoding", "chunked");
                log.info(req, res, "Creating zip of /", req.url.substring(4));

                archive = archiver(type, {zlib: { level: config.zipLevel }});
                archive.on("error", function (error) { log.error(error); });

                next = function (currentPath) {
                    if (currentPath[currentPath.length - 1] !== "/")
                        archive.file(currentPath, {name: removeFilePath(currentPath)});
                    else
                        archive.append("", { name: removeFilePath(currentPath) });
                };

                archive.on("entry", function () {
                    if (paths.length)
                        next(paths.pop());
                    else
                        archive.finalize();
                });
                archive.pipe(res);

                utils.walkDirectory(zipPath, true, function (error, foundPaths) {
                    if (error) log.error(error);
                    paths = foundPaths.filter(function (s) { return s !== ""; });
                    next(paths.pop());
                });
            } else {
                res.statusCode = 404;
                res.end();
                log.info(req, res);
            }
        });
    }

    //-----------------------------------------------------------------------------
    // Argument handler
    function handleArguments() {
        var args = process.argv.slice(2), option = args[0];
        config = cfg(path.join(process.cwd(), "config.json"));

        if (option === "list" && args.length === 1) {
            readDB();
            log.simple(["Active Users: "].concat(chalk.magenta(Object.keys(db.users).join(", "))).join(""));
            process.exit(0);
        } else if (option === "add" && args.length === 3) {
            readDB();
            process.exit(addOrUpdateUser(args[1], args[2], true));
        } else if (option === "del" && args.length === 2) {
            readDB();
            process.exit(delUser(args[1]));
        } else if (option === "version" || option === "-v" || option === "--version") {
            log.simple(version);
            process.exit(0);
        } else {
            printUsage(1);
        }

        function printUsage(exitCode) {
            log.simple(log.usage);
            process.exit(exitCode);
        }
    }

    //-----------------------------------------------------------------------------
    // Read and validate the user database
    function readDB() {
        var dbString = "";
        var doWrite = false;

        try {
            dbString = String(fs.readFileSync(config.db));
            db = JSON.parse(dbString);

            // Create sub-objects in case they aren't here
            if (Object.keys(db).length !== 3) doWrite = true;
            if (!db.users) db.users = {};
            if (!db.sessions) db.sessions = {};
            if (!db.shortlinks) db.shortlinks = {};
        } catch (error) {
            if (error.code === "ENOENT" || /^\s*$/.test(dbString)) {
                db = {users: {}, sessions: {}, shortlinks: {}};

                // Recreate DB file in case it doesn't exist / is empty
                log.simple("Creating ", chalk.magenta(path.basename(config.db)), "...");
                doWrite = true;
            } else {
                log.error("Error reading ", config.db, "\n", util.inspect(error));
                process.exit(1);
            }
        }

        // Write a new DB if necessary
        if (doWrite) writeDB();
    }

    //-----------------------------------------------------------------------------
    // Add a user to the database
    function addOrUpdateUser(user, password, privileged) {
        var salt = crypto.randomBytes(4).toString("hex"), isNew = !db.users[user];
        db.users[user] = {
            hash: utils.getHash(password + salt + user) + "$" + salt,
            privileged: privileged
        };
        writeDB();
        if (isCLI) log.simple(chalk.magenta(user), " successfully ", isNew ? "added." : "updated.");
        return 1;
    }

    //-----------------------------------------------------------------------------
    // Remove a user from the database
    function delUser(user) {
        if (db.users[user]) {
            delete db.users[user];
            writeDB();
            if (isCLI) log.simple(chalk.magenta(user), " successfully removed.");
            return 0;
        } else {
            if (isCLI) log.simple(chalk.magenta(user), " does not exist!");
            return 1;
        }
    }

    //-----------------------------------------------------------------------------
    // Check if user/password is valid
    function isValidUser(user, pass) {
        var parts;
        if (db.users[user]) {
            parts = db.users[user].hash.split("$");
            if (parts.length === 2 && parts[0] === utils.getHash(pass + parts[1] + user))
                return true;
        }
        return false;
    }

    //-----------------------------------------------------------------------------
    // Cookie functions

    var cookieName = "s", needToSave = false;

    function getCookie(cookie) {
        var session = "", cookies;
        if (cookie) {
            cookies = cookie.split("; ");
            cookies.forEach(function (c) {
                if (new RegExp("^" + cookieName + ".*").test(c)) {
                    session = c.substring(cookieName.length + 1);
                }
            });
            for (var savedsession in db.sessions) {
                if (db.sessions.hasOwnProperty(savedsession)) {
                    if (savedsession === session) {
                        db.sessions[session].lastSeen = Date.now();
                        needToSave = true;
                        return session;
                    }
                }
            }
        }
        return false;
    }

    function freeCookie(req, res) {
        var dateString = new Date(Date.now() + 31536000000).toUTCString(),
            sessionID  = crypto.randomBytes(32).toString("base64");

        res.setHeader("Set-Cookie", cookieName + "=" + sessionID + ";expires=" + dateString + ";path=/");
        db.sessions[sessionID] = {privileged : true, lastSeen : Date.now()};
        writeDB();
    }

    function createCookie(req, res, postData) {
        var sessionID = crypto.randomBytes(32).toString("base64"), priv, dateString;

        priv = db.users[postData.username].privileged;
        if (postData.check === "on") {
            // Create a semi-permanent cookie
            dateString = new Date(Date.now() + 31536000000).toUTCString();
            res.setHeader("Set-Cookie", cookieName + "=" + sessionID + ";expires=" + dateString + ";path=/");
        } else {
            // Create a single-session cookie
            res.setHeader("Set-Cookie", cookieName + "=" + sessionID + ";path=/");
        }
        db.sessions[sessionID] = {privileged : priv, lastSeen : Date.now()};
        writeDB();
    }

    // Clean inactive sessions after 1 month of inactivity, and check their age hourly
    setInterval(cleanUpSessions, 3600000);
    function cleanUpSessions() {
        for (var session in db.sessions) {
            if (db.sessions.hasOwnProperty(session)) {
                if (!db.sessions[session].lastSeen || (Date.now() - db.sessions[session].lastSeen >= 2678400000)) {
                    delete db.sessions[session];
                    needToSave = true;
                }
            }
        }
    }

    //-----------------------------------------------------------------------------
    // Watch the CSS files for debugging
    function watchCSS() {
        resources.css.forEach(function (file) {
            fs.watch(path.join(__dirname, file), utils.debounce(updateCSS), config.readInterval);
        });
    }

    //-----------------------------------------------------------------------------
    // Update the debug CSS cache and send it to the client(s)
    function updateCSS() {
        var temp = "";
        resources.css.forEach(function (file) {
            temp += fs.readFileSync(file).toString("utf8") + "\n";
        });
        cssCache = ap("last 2 versions").process(temp).css;
        for (var cookie in clients) {
            if (clients.hasOwnProperty(cookie)) {
                var data = JSON.stringify({
                    "type"  : "UPDATE_CSS",
                    "css"   : cssCache
                });
                if (clients[cookie].ws && clients[cookie].ws.readyState === 1) {
                    clients[cookie].ws.send(data, function (error) {
                        if (error) log.error(error);
                    });
                }
            }
        }
    }

    //-----------------------------------------------------------------------------
    // Various helper functions
    function writeDB()         { fs.writeFileSync(config.db, JSON.stringify(db, null, 4)); }

    function getResPath(name)  { return path.join(config.resDir, name); }
    function getSrcPath(name)  { return path.join(config.srcDir, name); }

    // removeFilePath is intentionally not an inverse to the add function
    function addFilePath(p)    { return utils.fixPath(config.filesDir + p); }
    function removeFilePath(p) { return utils.fixPath("/" + utils.fixPath(p).replace(utils.fixPath(config.filesDir), "")); }

    //-----------------------------------------------------------------------------
    // Process signal and events
    process
        .on("SIGINT",  function () { shutdown("SIGINT");  })
        .on("SIGQUIT", function () { shutdown("SIGQUIT"); })
        .on("SIGTERM", function () { shutdown("SIGTERM"); })
        .on("uncaughtException", function (error) {
            log.error("=============== Uncaught exception! ===============");
            log.error(error.stack);
        });

    //-----------------------------------------------------------------------------
    function shutdown(signal) {
        log.simple("Received " + signal + " - Shutting down...");
        var count = 0;
        for (var client in clients) {
            if (clients.hasOwnProperty(client)) {
                if (!clients[client] || !clients[client].ws) continue;
                if (clients[client].ws.readyState < 2) {
                    count++;
                    clients[client].ws.close(1001);
                }
            }
        }

        if (count > 0) log.simple("Closed " + count + " active WebSocket" + (count > 1 ? "s" : ""));

        cleanupTemp();
        cleanUpSessions();
        writeDB();

        process.exit(0);
    }
})();
