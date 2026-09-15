const fs = require("node:fs");
const https = require("node:https");
const { EventEmitter } = require("node:events");

const responses = JSON.parse(process.env.MOCK_HTTP_RESPONSES);

https.get = (options, callback) => {
  const url = `https://${options.hostname}${options.path}`;
  fs.appendFileSync(process.env.MOCK_HTTP_LOG, `${url}\n`);
  const request = new EventEmitter();
  request.setTimeout = () => request;
  request.destroy = () => request;

  process.nextTick(() => {
    if (!Object.hasOwn(responses, url)) {
      throw new Error(`Unexpected HTTPS request: ${url}`);
    }
    const response = new EventEmitter();
    response.statusCode = 200;
    response.headers = {};
    callback(response);
    response.emit("data", Buffer.from(responses[url]));
    response.emit("end");
  });

  return request;
};
