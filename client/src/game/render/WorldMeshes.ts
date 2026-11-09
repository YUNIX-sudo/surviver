// Procedural low-poly meshes for the world: resources, Core, buildings, health bars, name labels.

import * as THREE from 'three';
import { BuildingKind, CELL_SIZE, ResourceKind, mulberry32 } from '@surviver/shared';

const std = (color: number, o: Partial<THREE.MeshStandardMaterialParameters> = {}) => new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.85, ...o });

const M = {
  trunk: std(0x7a4b26),
  leaves: [std(0x2f7d32), std(0x3f9a3a), std(0x4caf50), std(0x2e6b30)],
  rock: std(0x8a8f98),
  rockDark: std(0x6b7078),
  ironRock: std(0x4a4440),
  iron: std(0xd97706, { metalness: 0.6, roughness: 0.35, emissive: 0x3a1a00 }),
  ironShine: std(0xcbd5e1, { metalness: 0.8, roughness: 0.25 }),
  wood: std(0xa0673a),
  woodDark: std(0x6f4422),
  metal: std(0x9ca3af, { metalness: 0.7, roughness: 0.35 }),
  stone: std(0x9ca3af),
  stoneDark: std(0x6b7280),
  coreBase: std(0x334155),
  core: std(0x38bdf8, { emissive: 0x0ea5e9, emissiveIntensity: 0.9, roughness: 0.2 }),
};

function m(g: THREE.BufferGeometry, mat: THREE.Material) {
  const o = new THREE.Mesh(g, mat);
  o.castShadow = true;
  o.receiveShadow = true;
  return o;
}

// ───────────────────────────── resources ─────────────────────────────

export function makeResource(id: number, k: number): THREE.Group {
  const rnd = mulberry32(id * 9301 + 49297);
  const g = new THREE.Group();
  if (k === ResourceKind.Tree) {
    const h = 1.2 + rnd() * 0.6;
    const trunk = m(new THREE.CylinderGeometry(0.18, 0.28, h, 6), M.trunk);
    trunk.position.y = h / 2;
    g.add(trunk);
    const pine = rnd() < 0.5;
    const leaf = M.leaves[Math.floor(rnd() * M.leaves.length)]!;
    if (pine) {
      for (let i = 0; i < 3; i++) {
        const c = m(new THREE.ConeGeometry(1.1 - i * 0.28, 1.2, 7), leaf);
        c.position.y = h + 0.3 + i * 0.6;
        c.rotation.y = rnd() * 3;
        g.add(c);
      }
    } else {
      for (let i = 0; i < 3; i++) {
        const c = m(new THREE.IcosahedronGeometry(0.7 + rnd() * 0.3, 0), leaf);
        c.position.set((rnd() - 0.5) * 0.7, h + 0.4 + rnd() * 0.5, (rnd() - 0.5) * 0.7);
        c.rotation.set(rnd() * 3, rnd() * 3, 0);
        g.add(c);
      }
    }
  } else if (k === ResourceKind.Rock) {
    const big = m(new THREE.DodecahedronGeometry(0.95, 0), M.rock);
    big.scale.set(1, 0.7 + rnd() * 0.3, 1);
    big.position.y = 0.45;
    big.rotation.set(rnd(), rnd() * 3, rnd());
    g.add(big);
    for (let i = 0; i < 2; i++) {
      const s = m(new THREE.DodecahedronGeometry(0.4, 0), M.rockDark);
      s.position.set((rnd() - 0.5) * 1.6, 0.2, (rnd() - 0.5) * 1.6);
      s.rotation.set(rnd(), rnd(), rnd());
      g.add(s);
    }
  } else {
    const base = m(new THREE.DodecahedronGeometry(0.85, 0), M.ironRock);
    base.scale.set(1, 0.65, 1);
    base.position.y = 0.35;
    base.rotation.y = rnd() * 3;
    g.add(base);
    for (let i = 0; i < 5; i++) {
      const c = m(new THREE.OctahedronGeometry(0.18 + rnd() * 0.15, 0), i % 2 ? M.iron : M.ironShine);
      const a = rnd() * Math.PI * 2;
      c.position.set(Math.cos(a) * 0.5, 0.55 + rnd() * 0.3, Math.sin(a) * 0.5);
      c.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
      g.add(c);
    }
  }
  g.rotation.y = rnd() * Math.PI * 2;
  return g;
}

// ───────────────────────────── Core ─────────────────────────────

export class CoreMesh {
  readonly root = new THREE.Group();
  private crystal: THREE.Mesh;
  private ring: THREE.Mesh;
  private light: THREE.PointLight;
  private t = 0;
  private shake = 0;

  constructor() {
    const base = m(new THREE.CylinderGeometry(2.1, 2.4, 0.6, 6), M.coreBase);
    base.position.y = 0.3;
    this.root.add(base);
    const step = m(new THREE.CylinderGeometry(1.5, 1.8, 0.4, 6), M.stoneDark);
    step.position.y = 0.8;
    this.root.add(step);
    for (let i = 0; i < 6; i++) {
      const pillar = m(new THREE.BoxGeometry(0.3, 1.6, 0.3), M.stone);
      const a = (i / 6) * Math.PI * 2;
      pillar.position.set(Math.cos(a) * 1.75, 1.1, Math.sin(a) * 1.75);
      this.root.add(pillar);
    }
    this.crystal = m(new THREE.OctahedronGeometry(0.9, 0), M.core);
    this.crystal.scale.set(1, 1.6, 1);
    this.crystal.position.y = 2.6;
    this.root.add(this.crystal);
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(1.3, 0.06, 6, 24), new THREE.MeshBasicMaterial({ color: 0x7dd3fc }));
    this.ring.position.y = 2.6;
    this.ring.rotation.x = Math.PI / 2;
    this.root.add(this.ring);
    this.light = new THREE.PointLight(0x38bdf8, 25, 14, 1.6);
    this.light.position.y = 3;
    this.root.add(this.light);
  }

  hit() {
    this.shake = 1;
  }

  update(dt: number, hpRatio: number) {
    this.t += dt;
    this.crystal.rotation.y += dt * 0.8;
    this.crystal.position.y = 2.6 + Math.sin(this.t * 2) * 0.15;
    this.ring.rotation.z += dt * 1.5;
    this.ring.position.y = this.crystal.position.y;
    const danger = 1 - hpRatio;
    const c = new THREE.Color(0x38bdf8).lerp(new THREE.Color(0xef4444), danger);
    (this.crystal.material as THREE.MeshStandardMaterial).emissive.copy(c).multiplyScalar(0.8);
    this.light.color.copy(c);
    this.light.intensity = 20 + Math.sin(this.t * (3 + danger * 10)) * 6;
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 4);
      this.crystal.position.x = (Math.random() - 0.5) * this.shake * 0.3;
    }
  }
}

// ───────────────────────────── buildings ─────────────────────────────

export function makeBuilding(k: number): THREE.Group {
  const g = new THREE.Group();
  const S = CELL_SIZE;
  if (k === BuildingKind.Wall) {
    const core = m(new THREE.BoxGeometry(S * 0.96, 1.7, S * 0.96), M.wood);
    core.position.y = 0.85;
    g.add(core);
    for (let i = 0; i < 3; i++) {
      const plank = m(new THREE.BoxGeometry(S * 1.0, 0.14, S * 1.0), M.woodDark);
      plank.position.y = 0.3 + i * 0.6;
      g.add(plank);
    }
    for (let i = 0; i < 4; i++) {
      const spike = m(new THREE.ConeGeometry(0.16, 0.45, 5), M.woodDark);
      spike.position.set(((i % 2) - 0.5) * S * 0.6, 1.9, (Math.floor(i / 2) - 0.5) * S * 0.6);
      g.add(spike);
    }
  } else if (k === BuildingKind.Spikes) {
    const plate = m(new THREE.BoxGeometry(S * 0.95, 0.12, S * 0.95), M.woodDark);
    plate.position.y = 0.06;
    g.add(plate);
    for (let ix = 0; ix < 3; ix++)
      for (let iz = 0; iz < 3; iz++) {
        const c = m(new THREE.ConeGeometry(0.13, 0.6, 4), M.metal);
        c.position.set((ix - 1) * 0.6, 0.4, (iz - 1) * 0.6);
        c.rotation.set((Math.random() - 0.5) * 0.4, 0, (Math.random() - 0.5) * 0.4);
        g.add(c);
      }
  } else {
    const base = m(new THREE.CylinderGeometry(0.85, 0.95, 1.1, 8), M.stone);
    base.position.y = 0.55;
    g.add(base);
    const head = new THREE.Group();
    head.name = 'head';
    head.position.y = 1.35;
    const box = m(new THREE.BoxGeometry(0.8, 0.5, 0.8), M.stoneDark);
    head.add(box);
    const barrel = m(new THREE.CylinderGeometry(0.1, 0.12, 1.0, 6), M.metal);
    barrel.name = 'barrel';
    barrel.rotation.x = Math.PI / 2;
    barrel.position.z = 0.6;
    head.add(barrel);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.09, 6, 4), new THREE.MeshBasicMaterial({ color: 0xff3b30 }));
    eye.position.set(0, 0.1, 0.41);
    head.add(eye);
    g.add(head);
  }
  return g;
}

// ───────────────────────────── HP bars & labels ─────────────────────────────

const barBgMat = new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.6, depthTest: false });
const barGeo = new THREE.PlaneGeometry(1, 1);

export class HpBar {
  readonly root = new THREE.Group();
  private fg: THREE.Mesh;
  private fgMat: THREE.MeshBasicMaterial;
  constructor(
    private width = 1,
    private color = 0x22c55e,
  ) {
    const bg = new THREE.Mesh(barGeo, barBgMat);
    bg.scale.set(width + 0.06, 0.16, 1);
    bg.renderOrder = 10;
    // transparent too: three.js draws all opaque objects before transparent ones regardless of renderOrder,
    // so an opaque fill would end up UNDER the semi-transparent background and look dark
    this.fgMat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true });
    this.fg = new THREE.Mesh(barGeo, this.fgMat);
    this.fg.scale.set(width, 0.1, 1);
    this.fg.renderOrder = 11;
    this.root.add(bg, this.fg);
  }
  set(ratio: number, camera: THREE.Camera) {
    const r = Math.max(0, Math.min(1, ratio));
    this.fg.scale.x = Math.max(0.0001, this.width * r);
    this.fg.position.x = -(this.width * (1 - r)) / 2;
    this.fgMat.color.setHex(r > 0.5 ? this.color : r > 0.25 ? 0xeab308 : 0xef4444);
    this.root.quaternion.copy(camera.quaternion);
    this.root.visible = r < 0.999;
  }
  dispose() {
    this.fgMat.dispose();
    this.root.removeFromParent();
  }
}

export function makeLabel(text: string, color = '#ffffff'): THREE.Sprite {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = 'bold 40px system-ui, sans-serif';
  const w = Math.ceil(ctx.measureText(text).width) + 24;
  c.width = w;
  c.height = 56;
  ctx.font = 'bold 40px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.roundRect(0, 0, w, 56, 16);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 12, 30);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  s.scale.set((w / 56) * 0.45, 0.45, 1);
  s.renderOrder = 12;
  return s;
}
