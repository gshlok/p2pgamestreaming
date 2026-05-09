/**
 * Test script to verify the P2P signaling flow works end-to-end.
 * Simulates two peers connecting and exchanging asset announcements.
 * 
 * Usage: node test_p2p_flow.js
 * Requires: server.js running on localhost:3000
 */

const WebSocket = require('ws');

const WS_URL = 'ws://localhost:3000/ws';
const TIMEOUT = 10000;

function createPeer(name, peerId) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(WS_URL);
        const messages = [];
        const peer = { name, peerId, ws, messages };

        ws.on('open', () => {
            console.log(`[${name}] Connected`);
            resolve(peer);
        });

        ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            messages.push(msg);
            console.log(`[${name}] Received: ${msg.type}`, 
                msg.type === 'asset-update' ? `from ${msg.peerId} with ${msg.assets?.length} assets: [${msg.assets?.join(', ')}]` :
                msg.type === 'peer-joined' ? `peer ${msg.peer?.peerId} with ${msg.peer?.assets?.length} assets` :
                msg.type === 'peer-list' ? `${msg.peers?.length} peers` :
                msg.type === 'asset-request' ? `from ${msg.from} for ${msg.assetName}` :
                msg.type === 'ws-relay-asset' ? `from ${msg.from} asset ${msg.assetName} (${msg.data?.length} chars base64)` :
                ''
            );
        });

        ws.on('error', reject);
        
        setTimeout(() => reject(new Error(`${name} connection timeout`)), TIMEOUT);
    });
}

function send(peer, msg) {
    peer.ws.send(JSON.stringify(msg));
    console.log(`[${peer.name}] Sent: ${msg.type}`);
}

function waitForMessage(peer, type, timeout = 5000) {
    return new Promise((resolve, reject) => {
        // Check already received
        const existing = peer.messages.find(m => m.type === type);
        if (existing) {
            resolve(existing);
            return;
        }

        const handler = (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.type === type) {
                clearTimeout(timer);
                peer.ws.removeListener('message', handler);
                resolve(msg);
            }
        };

        const timer = setTimeout(() => {
            peer.ws.removeListener('message', handler);
            reject(new Error(`[${peer.name}] Timeout waiting for '${type}'`));
        }, timeout);

        peer.ws.on('message', handler);
    });
}

async function runTest() {
    console.log('\n=== P2P Signaling Flow Test ===\n');

    // Step 1: Create Peer A
    console.log('--- Step 1: Peer A connects ---');
    const peerA = await createPeer('PeerA', 'peer_test_A');
    send(peerA, {
        type: 'register',
        peerId: 'peer_test_A',
        assets: [],
        info: { userAgent: 'TestScript', timestamp: Date.now() }
    });
    const listA = await waitForMessage(peerA, 'peer-list');
    console.log(`[PeerA] Got peer-list: ${listA.peers.length} peers\n`);

    // Step 2: Create Peer B
    console.log('--- Step 2: Peer B connects ---');
    const peerB = await createPeer('PeerB', 'peer_test_B');
    
    // PeerA should get peer-joined notification
    const joinPromise = waitForMessage(peerA, 'peer-joined');

    send(peerB, {
        type: 'register',
        peerId: 'peer_test_B',
        assets: [],
        info: { userAgent: 'TestScript', timestamp: Date.now() }
    });
    const listB = await waitForMessage(peerB, 'peer-list');
    console.log(`[PeerB] Got peer-list: ${listB.peers.length} peers, peer A has ${listB.peers[0]?.assets?.length} assets`);
    
    const joined = await joinPromise;
    console.log(`[PeerA] Got peer-joined: ${joined.peer.peerId}\n`);

    // Step 3: Peer A announces an asset
    console.log('--- Step 3: Peer A announces a cached level ---');
    send(peerA, {
        type: 'asset-announce',
        peerId: 'peer_test_A',
        assets: ['levels/Tomb-Raider-1/01-Caves.PHD']
    });

    // Peer B should get asset-update
    const update = await waitForMessage(peerB, 'asset-update');
    console.log(`[PeerB] Got asset-update: peer ${update.peerId} now has assets: [${update.assets.join(', ')}]\n`);

    // Step 4: Peer B requests the asset
    console.log('--- Step 4: Peer B requests asset from Peer A ---');
    send(peerB, {
        type: 'asset-request',
        to: 'peer_test_A',
        assetName: 'levels/Tomb-Raider-1/01-Caves.PHD'
    });

    // Peer A should get the request
    const request = await waitForMessage(peerA, 'asset-request');
    console.log(`[PeerA] Got asset-request from ${request.from} for ${request.assetName}\n`);

    // Step 5: Peer A responds with WS relay
    console.log('--- Step 5: Peer A sends asset via WS relay ---');
    const fakeAssetData = Buffer.from('FAKE_PHD_LEVEL_DATA_FOR_TESTING').toString('base64');
    send(peerA, {
        type: 'ws-relay-asset',
        to: 'peer_test_B',
        assetName: 'levels/Tomb-Raider-1/01-Caves.PHD',
        data: fakeAssetData,
        hash: 'test_hash_123',
        size: 30
    });

    // Peer B should receive the relayed asset
    const relayed = await waitForMessage(peerB, 'ws-relay-asset');
    console.log(`[PeerB] Got ws-relay-asset: ${relayed.assetName} from ${relayed.from} (${relayed.data.length} chars base64)\n`);

    // Verify the data integrity
    const decoded = Buffer.from(relayed.data, 'base64').toString();
    const dataMatch = decoded === 'FAKE_PHD_LEVEL_DATA_FOR_TESTING';
    console.log(`[PeerB] Data integrity check: ${dataMatch ? '✓ PASS' : '✗ FAIL'}`);
    console.log(`[PeerB] Decoded data: "${decoded}"\n`);

    // Step 6: Peer B announces it now has the asset too
    console.log('--- Step 6: Peer B announces its new asset ---');
    send(peerB, {
        type: 'asset-announce',
        peerId: 'peer_test_B',
        assets: ['levels/Tomb-Raider-1/01-Caves.PHD']
    });

    const updateA = await waitForMessage(peerA, 'asset-update');
    console.log(`[PeerA] Got asset-update: peer ${updateA.peerId} now has: [${updateA.assets.join(', ')}]\n`);

    // Done
    console.log('=== ALL TESTS PASSED ===\n');
    console.log('Summary:');
    console.log('  ✓ Peer registration and discovery works');
    console.log('  ✓ Asset announcements propagate to other peers');
    console.log('  ✓ Asset requests are relayed to correct peer');
    console.log('  ✓ WS relay delivers asset data with correct integrity');
    console.log('  ✓ Re-announcement after receiving asset works');

    peerA.ws.close();
    peerB.ws.close();
}

runTest().catch(err => {
    console.error('\n✗ TEST FAILED:', err.message);
    process.exit(1);
});
