// Test-only local servers for tests/gjs/transport.mjs: HTTPS offering HTTP/2 and HTTP/1.1 like the
// real price APIs, plus plain HTTP as a downgrade target. Prints "<https port> <http port> <cert path>",
// then "<protocol> <client port> <path>" per request. Exits and deletes its files when stdin closes,
// so a killed test run leaves no server or certificate behind.
import {createSecureServer} from 'node:http2';
import {createServer} from 'node:http';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'btcprice-tls-'));
const cleanup = () => { rmSync(dir, {recursive: true, force: true}); process.exit(0); };
process.stdin.on('end', cleanup).resume();
process.on('SIGTERM', cleanup);
const cert = join(dir, 'cert.pem'), keyFile = join(dir, 'key.pem');
const openssl = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyFile, '-out', cert], {encoding: 'utf8'});
if (openssl.status !== 0) { rmSync(dir, {recursive: true, force: true}); throw new Error(`openssl could not create the test certificate: ${openssl.stderr}`); }
const key = readFileSync(keyFile);
rmSync(keyFile);

const price = '{"price":"61763.77"}';
const plain = createServer((request, response) => {
    console.log(`plain ${request.socket.remotePort} ${request.url}`);
    response.end(price);
});
const tls = createSecureServer({key, cert: readFileSync(cert), allowHTTP1: true}, (request, response) => {
    console.log(`${request.httpVersion} ${request.socket.remotePort} ${request.url}`);
    if (request.url === '/redirect') {
        response.writeHead(302, {location: `http://127.0.0.1:${plain.address().port}/price`});
        response.end();
    } else if (request.url === '/trickle') {
        // One byte per second: every socket wait is short, but the body never ends.
        response.writeHead(200, {'content-type': 'application/json'});
        response.write('{');
        const timer = setInterval(() => response.write(' '), 1000);
        response.on('close', () => clearInterval(timer));
    } else {
        response.writeHead(200, {'content-type': 'application/json'});
        response.end(price);
    }
});
// Idle HTTP/1.1 connections stay open longer than a poll interval, as Coinbase's did when measured.
tls.keepAliveTimeout = 60_000;
await new Promise(resolve => plain.listen(0, '127.0.0.1', resolve));
await new Promise(resolve => tls.listen(0, '127.0.0.1', resolve));
console.log(`${tls.address().port} ${plain.address().port} ${cert}`);
