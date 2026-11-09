// Procedural TABS-style character: bean body, googly eyes, stubby limbs, wobbly spring animation.
// No external assets — everything is built from Three.js primitives.

import * as THREE from 'three';

export type CharacterStyle = 'player' | 'runner' | 'grunt' | 'giant';

export interface CharacterOptions {
  color: number;
  style: CharacterStyle;
  scale?: number;
}

const geoCache = new Map<string, THREE.BufferGeometry>();
function geo<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
  let g = geoCache.get(key);
  if (!g) geoCache.set(key, (g = make()));
  return g as T;
}
const matCache = new Map<string, THREE.Material>();
function mat(color: number, opts: { emissive?: number; rough?: number; metal?: number } = {}) {
  const key = `${color}|${opts.emissive ?? 0}|${opts.rough ?? 0.8}|${opts.metal ?? 0}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: opts.rough ?? 0.8, metalness: opts.metal ?? 0, emissive: opts.emissive ?? 0 });
    matCache.set(key, m);
  }
  return m;
}

function mesh(g: THREE.BufferGeometry, m: THREE.Material, cast = true) {
  const o = new THREE.Mesh(g, m);
  o.castShadow = cast;
  o.receiveShadow = false;
  return o;
}

/** Damped spring used for wobble / lean / googly pupils. */
class Spring {
  v = 0;
  x = 0;
  constructor(
    public k = 60,
    public d = 6,
  ) {}
  step(target: number, dt: number) {
    const a = (target - this.x) * this.k - this.v * this.d;
    this.v += a * dt;
    this.x += this.v * dt;
    return this.x;
  }
  kick(v: number) {
    this.v += v;
  }
}

export class TabsCharacter {
  readonly root = new THREE.Group();
  private readonly body = new THREE.Group(); // everything that wobbles
  private readonly legL = new THREE.Group();
  private readonly legR = new THREE.Group();
  private readonly armL = new THREE.Group();
  private readonly armR = new THREE.Group();
  private readonly pupils: THREE.Mesh[] = [];
  private readonly bodyMeshes: THREE.Mesh[] = [];
  private bodyMat: THREE.MeshStandardMaterial;
  private baseColor: THREE.Color;
  private phase = Math.random() * 10;
  private leanX = new Spring(40, 5);
  private leanZ = new Spring(35, 3.5);
  private squash = new Spring(120, 8);
  private pupilX = new Spring(90, 4);
  private pupilY = new Spring(90, 4);
  private lastPos = new THREE.Vector3();
  private speed = 0;
  private actionT = 1;
  private actionKind = 0;
  private flash = 0;
  private deadT = -1;
  private deathDir = 1;
  readonly s: number;
  readonly height: number;

  constructor(opts: CharacterOptions) {
    const s = (this.s = opts.scale ?? 1);
    const style = opts.style;
    this.bodyMat = new THREE.MeshStandardMaterial({ color: opts.color, flatShading: true, roughness: 0.75 });
    this.baseColor = new THREE.Color(opts.color);
    const darker = new THREE.Color(opts.color).multiplyScalar(0.6).getHex();

    // proportions per style
    const bodyR = style === 'giant' ? 0.5 : style === 'runner' ? 0.36 : 0.38;
    const bodyH = style === 'giant' ? 0.55 : style === 'runner' ? 0.25 : 0.45;
    const eyeR = style === 'runner' ? 0.17 : style === 'giant' ? 0.11 : 0.13;
    const legLen = style === 'runner' ? 0.38 : 0.32;
    const hipY = legLen + 0.05;

    // ── body (bean) ──
    const torso = mesh(geo(`torso${bodyR}${bodyH}`, () => new THREE.CapsuleGeometry(bodyR, bodyH, 4, 10)), this.bodyMat);
    torso.position.y = bodyR + bodyH / 2;
    this.bodyMeshes.push(torso);
    this.body.add(torso);
    this.body.position.y = hipY;
    const topY = bodyR * 2 + bodyH;
    this.height = (hipY + topY + 0.3) * s;

    // belly / belt
    const belt = mesh(geo(`belt${bodyR}`, () => new THREE.CylinderGeometry(bodyR * 1.02, bodyR * 1.02, 0.09, 10)), mat(darker));
    belt.position.y = bodyR * 0.75;
    this.body.add(belt);

    // ── googly eyes ──
    const eyeY = topY * 0.72;
    for (const side of [-1, 1]) {
      const eye = mesh(geo(`eye${eyeR}`, () => new THREE.SphereGeometry(eyeR, 10, 8)), mat(0xffffff, { rough: 0.3 }), false);
      const ex = side * bodyR * 0.45;
      const ez = Math.sqrt(Math.max(0.01, bodyR * bodyR - ex * ex)) * 0.92;
      eye.position.set(ex, eyeY, ez);
      this.body.add(eye);
      const pupil = mesh(geo(`pupil${eyeR}`, () => new THREE.SphereGeometry(eyeR * 0.5, 8, 6)), mat(0x111111, { rough: 0.2 }), false);
      pupil.position.set(ex, eyeY, ez + eyeR * 0.62);
      pupil.userData.base = pupil.position.clone();
      this.pupils.push(pupil);
      this.body.add(pupil);
      if (style === 'grunt' || style === 'giant') {
        // angry brows
        const brow = mesh(geo('brow', () => new THREE.BoxGeometry(0.2, 0.04, 0.05)), mat(0x1a1a1a), false);
        brow.position.set(ex, eyeY + eyeR + 0.02, ez + 0.03);
        brow.rotation.z = side * 0.35;
        brow.scale.setScalar(style === 'giant' ? 1.3 : 1);
        this.body.add(brow);
      }
    }
    // mouth
    if (style !== 'player') {
      const mouth = mesh(geo('mouth', () => new THREE.BoxGeometry(0.16, 0.05, 0.04)), mat(0x2a0a0a), false);
      mouth.position.set(0, eyeY - eyeR - 0.08, bodyR * 0.95);
      this.body.add(mouth);
      if (style === 'giant' || style === 'runner') {
        for (const side of [-1, 1]) {
          const tooth = mesh(geo('tooth', () => new THREE.ConeGeometry(0.025, 0.07, 4)), mat(0xfffff0), false);
          tooth.position.set(side * 0.05, eyeY - eyeR - 0.11, bodyR * 0.97);
          tooth.rotation.x = Math.PI;
          this.body.add(tooth);
        }
      }
    }

    // ── headwear ──
    if (style === 'player') {
      const cap = mesh(geo('cap', () => new THREE.SphereGeometry(bodyR * 0.9, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2)), mat(darker));
      cap.position.y = topY - 0.12;
      cap.scale.set(1.05, 0.55, 1.05);
      this.body.add(cap);
      const visor = mesh(geo('visor', () => new THREE.BoxGeometry(bodyR * 1.2, 0.03, 0.22)), mat(darker));
      visor.position.set(0, topY - 0.12, bodyR * 0.9);
      this.body.add(visor);
    } else if (style === 'grunt') {
      const helm = mesh(geo('helm', () => new THREE.SphereGeometry(bodyR * 1.02, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2)), mat(0x6b7280, { metal: 0.6, rough: 0.4 }));
      helm.position.y = topY - 0.16;
      helm.scale.set(1, 0.7, 1);
      this.body.add(helm);
      const spike = mesh(geo('helmspike', () => new THREE.ConeGeometry(0.05, 0.18, 5)), mat(0x9ca3af, { metal: 0.6 }));
      spike.position.y = topY + 0.05;
      this.body.add(spike);
    } else if (style === 'giant') {
      for (const side of [-1, 1]) {
        const horn = mesh(geo('horn', () => new THREE.ConeGeometry(0.08, 0.35, 6)), mat(0xf5f5dc));
        horn.position.set(side * bodyR * 0.6, topY - 0.05, 0);
        horn.rotation.z = -side * 0.5;
        this.body.add(horn);
      }
    } else if (style === 'runner') {
      const tuft = mesh(geo('tuft', () => new THREE.ConeGeometry(0.1, 0.25, 4)), mat(darker));
      tuft.position.y = topY + 0.05;
      tuft.rotation.z = 0.3;
      this.body.add(tuft);
    }

    // ── arms ──
    const armLen = style === 'giant' ? 0.5 : 0.36;
    for (const [grp, side] of [
      [this.armL, -1],
      [this.armR, 1],
    ] as const) {
      grp.position.set(side * (bodyR + 0.06), topY * 0.55, 0);
      const arm = mesh(geo(`arm${armLen}`, () => new THREE.CapsuleGeometry(0.075, armLen, 3, 6)), this.bodyMat);
      arm.position.y = -armLen / 2;
      this.bodyMeshes.push(arm);
      grp.add(arm);
      const hand = mesh(geo('hand', () => new THREE.SphereGeometry(0.1, 6, 5)), this.bodyMat);
      hand.position.y = -armLen - 0.06;
      this.bodyMeshes.push(hand);
      grp.add(hand);
      grp.userData.handY = -armLen - 0.06;
      this.body.add(grp);
    }
    // tool in right hand
    const handY = this.armR.userData.handY as number;
    if (style === 'player') this.armR.add(this.makePickaxe(handY));
    else if (style === 'grunt') this.armR.add(this.makeClub(handY, 0.55, 0x7c4a1e));
    else if (style === 'giant') this.armR.add(this.makeClub(handY, 0.8, 0x4b3621, true));

    // ── legs ──
    for (const [grp, side] of [
      [this.legL, -1],
      [this.legR, 1],
    ] as const) {
      grp.position.set(side * bodyR * 0.45, hipY, 0);
      const leg = mesh(geo(`leg${legLen}`, () => new THREE.CapsuleGeometry(0.085, legLen - 0.1, 3, 6)), mat(darker));
      leg.position.y = -legLen / 2;
      grp.add(leg);
      const foot = mesh(geo('foot', () => new THREE.BoxGeometry(0.16, 0.08, 0.24)), mat(0x2b2b2b));
      foot.position.set(0, -legLen + 0.02, 0.05);
      grp.add(foot);
      this.root.add(grp);
    }

    this.root.add(this.body);
    this.root.scale.setScalar(s);
  }

  private makePickaxe(handY: number) {
    const g = new THREE.Group();
    const handle = mesh(geo('pickhandle', () => new THREE.CylinderGeometry(0.025, 0.025, 0.6, 5)), mat(0x8b5a2b));
    handle.rotation.x = Math.PI / 2;
    handle.position.z = 0.22;
    g.add(handle);
    const head = mesh(geo('pickhead', () => new THREE.BoxGeometry(0.42, 0.06, 0.06)), mat(0x9ca3af, { metal: 0.7, rough: 0.35 }));
    head.position.z = 0.5;
    g.add(head);
    for (const side of [-1, 1]) {
      const tip = mesh(geo('picktip', () => new THREE.ConeGeometry(0.035, 0.12, 4)), mat(0x9ca3af, { metal: 0.7, rough: 0.35 }));
      tip.rotation.z = (side * Math.PI) / 2;
      tip.position.set(side * 0.26, 0, 0.5);
      g.add(tip);
    }
    g.position.y = handY;
    return g;
  }

  private makeClub(handY: number, len: number, color: number, spiky = false) {
    const g = new THREE.Group();
    const club = mesh(geo(`club${len}`, () => new THREE.CylinderGeometry(0.11 * len * 1.6, 0.04, len, 6)), mat(color));
    club.rotation.x = Math.PI / 2;
    club.position.z = len / 2;
    g.add(club);
    if (spiky) {
      for (let i = 0; i < 5; i++) {
        const sp = mesh(geo('clubspike', () => new THREE.ConeGeometry(0.04, 0.14, 4)), mat(0xd1d5db, { metal: 0.5 }));
        const a = (i / 5) * Math.PI * 2;
        sp.position.set(Math.cos(a) * 0.15, Math.sin(a) * 0.15, len * 0.85);
        sp.rotation.set(0, 0, a - Math.PI / 2);
        g.add(sp);
      }
    }
    g.position.y = handY;
    return g;
  }

  /** Trigger a swing animation (harvest / attack). */
  swing(kind = 1) {
    if (this.actionT < 0.6) return;
    this.actionT = 0;
    this.actionKind = kind;
    this.leanX.kick(2.5);
  }

  hit() {
    this.flash = 1;
    this.squash.kick(-4);
    this.leanX.kick(-3);
    this.pupilX.kick((Math.random() - 0.5) * 30);
    this.pupilY.kick((Math.random() - 0.5) * 30);
  }

  die(dir = Math.random() < 0.5 ? -1 : 1) {
    if (this.deadT >= 0) return;
    this.deadT = 0;
    this.deathDir = dir;
  }

  revive() {
    this.deadT = -1;
    this.root.rotation.x = 0;
    this.root.rotation.z = 0;
    this.body.position.y = this.legL.position.y;
  }

  get isDead() {
    return this.deadT >= 0;
  }

  /** Called every render frame with the interpolated position & yaw. */
  update(dt: number, x: number, z: number, yaw: number) {
    const pos = this.root.position;
    const moved = Math.hypot(x - this.lastPos.x, z - this.lastPos.z);
    const instSpeed = dt > 0 ? moved / dt : 0;
    this.speed += (Math.min(instSpeed, 12) - this.speed) * Math.min(1, dt * 10);
    this.lastPos.set(x, 0, z);
    pos.set(x, 0, z);
    this.root.rotation.y = yaw;

    if (this.deadT >= 0) {
      // ragdoll-ish topple with a bounce
      this.deadT += dt;
      const t = Math.min(1, this.deadT / 0.45);
      const bounce = t < 1 ? t * t : 1 + Math.sin((this.deadT - 0.45) * 18) * Math.exp(-(this.deadT - 0.45) * 6) * 0.08;
      this.root.rotation.x = (-Math.PI / 2) * bounce * 0.95;
      this.root.rotation.z = this.deathDir * 0.4 * bounce;
      this.legL.rotation.x = 0.6;
      this.legR.rotation.x = -0.3;
      this.armL.rotation.z = -1.2;
      this.armR.rotation.z = 1.2;
      return;
    }

    const move = Math.min(1, this.speed / 4);
    const stride = 7 + this.speed * 1.4;
    this.phase += dt * stride * (move > 0.05 ? 1 : 0);
    const sw = Math.sin(this.phase);

    // legs & arms swing in opposite phase
    this.legL.rotation.x = sw * 0.9 * move;
    this.legR.rotation.x = -sw * 0.9 * move;
    this.armL.rotation.x = -sw * 0.8 * move;
    this.armL.rotation.z = -0.15 - move * 0.1;
    this.armR.rotation.z = 0.15 + move * 0.1;

    // drunken wobble: sway + forward lean with springy overshoot
    const lean = this.leanX.step(move * 0.28, dt);
    const sway = this.leanZ.step(Math.sin(this.phase * 0.5) * 0.22 * move + Math.sin(performance.now() / 700 + this.phase) * 0.03, dt);
    this.body.rotation.x = lean;
    this.body.rotation.z = sway;
    const bob = Math.abs(Math.sin(this.phase)) * 0.09 * move;
    const sq = this.squash.step(0, dt);
    this.body.position.y = this.legL.position.y + bob;
    this.body.scale.set(1 - sq * 0.15, 1 + sq * 0.25 + bob * 0.4, 1 - sq * 0.15);

    // action swing on right arm (overhead chop)
    if (this.actionT < 1) {
      this.actionT = Math.min(1, this.actionT + dt / 0.32);
      const t = this.actionT;
      const curve = t < 0.35 ? -(t / 0.35) * 2.6 : -2.6 + ((t - 0.35) / 0.65) * 3.4;
      this.armR.rotation.x = curve * (1 - Math.max(0, t - 0.8) * 5);
    } else {
      this.armR.rotation.x = sw * 0.8 * move - 0.2;
    }
    if (this.actionKind === 2 && this.actionT < 1) this.armL.rotation.x = -1.2;

    // googly pupils lag behind body movement
    const px = this.pupilX.step(-sway * 0.6, dt);
    const py = this.pupilY.step(-lean * 0.4 + bob, dt);
    for (const p of this.pupils) {
      const b = p.userData.base as THREE.Vector3;
      p.position.set(b.x + px * 0.06, b.y + py * 0.06, b.z);
    }

    // damage flash
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt * 4);
      this.bodyMat.emissive.setRGB(this.flash, this.flash * 0.2, this.flash * 0.2);
      this.bodyMat.color.copy(this.baseColor).lerp(new THREE.Color(0xffffff), this.flash * 0.3);
    }
  }

  setOpacity(o: number) {
    this.root.traverse((c) => {
      if (c instanceof THREE.Mesh) {
        const m = c.material as THREE.MeshStandardMaterial;
        if (o < 1 && !m.userData.cloned) {
          c.material = m.clone();
          (c.material as THREE.Material).userData.cloned = true;
        }
        const mm = c.material as THREE.MeshStandardMaterial;
        mm.transparent = o < 1;
        mm.opacity = o;
      }
    });
  }

  dispose() {
    this.bodyMat.dispose();
    this.root.traverse((c) => {
      if (c instanceof THREE.Mesh && (c.material as THREE.Material).userData.cloned) (c.material as THREE.Material).dispose();
    });
    this.root.removeFromParent();
  }
}
