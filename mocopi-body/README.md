# mocopi-body

Sony **mocopi** motion sensors → a body in the browser, and a few numbers
for what it's doing: how much it moves, how high the hands are, how open
it is, whether it's still. Made for Kacie (Dancer Mode in Water Synth), and
built to be lifted into any other instrument as it is: no dependencies,
nothing in it knows about Water Synth.

```
mocopi sensors ─BT→ phone (mocopi app) ─Wi-Fi, UDP→ bridge (laptop) ─→ any page (browser)
```

A web page can't receive UDP, so a tiny **bridge** runs on the laptop during
the show and passes the packets on.

## Try it now, without the sensors

```bash
node bridge/bridge.mjs --demo
```

Open **http://localhost:12352/**. A made-up dancer moves through still →
swaying → big arm sweeps → low and wide → travelling, and the viewer shows
her skeleton (from the front and from above) and every feature.

## With the sensors

1. Put the laptop and the phone on the **same Wi-Fi** (ideally the show's own
   network: mocopi sends its data unencrypted).
2. On the laptop: `node bridge/bridge.mjs`. It prints the laptop's address.
3. In the mocopi app: pair and calibrate the sensors as usual, then open the
   **PC connection** settings (Settings → External device / Network
   settings): transfer format **mocopi (UDP)**, the IP address the bridge
   printed, port **12351**. Start sending.
4. Open **http://localhost:12352/**. Stand still for a second first: the
   page learns which way is up and how tall the dancer is.

If nothing arrives: check the IP address and port, that the phone and laptop
are on the same network, and that the laptop's firewall lets Node receive
UDP on 12351 (macOS asks the first time; say Allow).

## Record and replay

```bash
node bridge/bridge.mjs --record kacie-take-1.mcp      # save what arrives (Ctrl-C to stop)
node bridge/bridge.mjs --replay kacie-take-1.mcp --loop  # play it back, as if live
```

A recorded take lets an instrument be built and tuned against her real
movement without her (or the sensors) in the room. Options: `--udp 12351`,
`--http 12352`, `--share` (let other computers on the network listen).

## In a page

```js
import { MocopiBody } from './mocopi-body/src/client.js';

const body = new MocopiBody({ url: 'http://localhost:12352' });
body.onframe = (b) => {
  const f = b.features;        // see below
  const head = b.skeleton.world[10]; // any bone's position in the room, metres
};
body.start();

function frame() {
  const f = body.tick();       // also marks the body lost when frames stop
  if (f.lost) { /* the sensors or the network dropped: not stillness */ }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

### Features (`body.features`)

| | range | what it is |
|---|---|---|
| `energy` | 0–1 | how much the body moves now (~0.3 s) — half the whole body, half its busiest part |
| `energyLong` | 0–1 | the same over a phrase (`longSeconds`, default 12 s) |
| `limbs` | m/s | `head`, `hips`, `leftHand`, `rightHand`, `leftFoot`, `rightFoot` |
| `height` | −1 … 1+ | hands against the body: 0 at the hips, 1 overhead, −1 at the floor |
| `level` | 0–1 | 1 standing, lower crouching or on the floor |
| `spread` | 0–1 | hands and feet far apart (open) vs. held in |
| `stillness` | s | how long she has been (nearly) still |
| `still` | bool | stillness has lasted `stillAfter` (3 s) |
| `centre` | m | the hips across the floor |
| `lost` | bool | no frames for `lostAfter` (0.5 s) — never counted as still |

Options: `new MocopiBody({ url, features: { up, bodyHeight, energyScale,
longSeconds, stillBelow, stillAfter, lostAfter } })`. `up` ('y', '-z', …)
and `bodyHeight` (metres) are learned when not given.

### The pieces

| file | |
|---|---|
| `src/smf.js` | mocopi's packet format: `parse()` (never throws), and encoders for tests |
| `src/skeleton.js` | the 27 bones (Sony's names), their parents, world positions |
| `src/features.js` | `BodyFeatures`: the numbers above |
| `src/client.js` | `MocopiBody`: the bridge's stream → skeleton → features |
| `src/demo.js` | the made-up dancer, as real packets |
| `bridge/bridge.mjs` | UDP → Server-Sent Events, recording, replay, the viewer |
| `web/index.html` | the viewer |
| `check/check.mjs` | `node check/check.mjs` |

## Notes

- **The packet format is unofficial.** Sony publishes the bone names; the
  byte layout here follows open-source receivers (mocopi_parser,
  mcp-receiver). The parser skips anything it doesn't know and returns
  null for anything broken. Bone parents come from the app's own skeleton
  packets (a table by name is the fallback until one arrives). Which way is
  up, and the units, aren't documented: up is learned, and the first real
  take should confirm positions are in metres (the viewer's 2 m floor box
  makes it obvious).
- **Who can listen.** The bridge serves this laptop only (127.0.0.1);
  `--share` opens it to other computers on the network. Any page open on
  the laptop may listen (so the instrument can be served from anywhere) —
  close pages you don't trust during a show.
- **Pages served from elsewhere.** The bridge allows any page to listen.
  Chrome lets an https page reach `http://localhost`; Safari doesn't, so
  with Safari serve the page from the laptop too.
- **Taking it to a new project:** copy this folder. Node 18+ for the bridge;
  any modern browser for the rest.
