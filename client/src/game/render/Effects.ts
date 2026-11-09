// Cheap particle bursts, turret tracers and floating damage numbers.

import * as THREE from 'three';

interface Particle {
  mesh: THREE.Mesh;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  spin: number;
}

const partGeo = new THREE.BoxGeometry(0.14, 0.14, 0.14);
const matCache = new Map<number, THREE.MeshStandardMaterial>();
const partMat = (c: number) => {
  let m = matCache.get(c);
  if (!m) matCache.set(c, (m = new THREE.MeshStandardMaterial({ color: c, flatShading: true })));
  return m;
};

export class Effects {
  private particles: Particle[] = [];
  private tracers: { line: THREE.Line; life: number }[] = [];
  private numbers: { el: HTMLDivElement; pos: THREE.Vector3; life: number }[] = [];
  private tmp = new THREE.Vector3();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly overlay: HTMLElement,
  ) {}

  burst(x: number, y: number, z: number, color: number, n = 8, power = 4) {
    for (let i = 0; i < n; i++) {
      if (this.particles.length > 400) break;
      const mesh = new THREE.Mesh(partGeo, partMat(color));
      mesh.position.set(x, y, z);
      mesh.scale.setScalar(0.6 + Math.random() * 0.8);
      this.scene.add(mesh);
      const a = Math.random() * Math.PI * 2;
      const sp = power * (0.4 + Math.random() * 0.6);
      this.particles.push({ mesh, vx: Math.cos(a) * sp, vy: 2 + Math.random() * power, vz: Math.sin(a) * sp, life: 0, max: 0.6 + Math.random() * 0.5, spin: (Math.random() - 0.5) * 20 });
    }
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3) {
    const g = new THREE.BufferGeometry().setFromPoints([from, to]);
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffe066, transparent: true }));
    this.scene.add(line);
    this.tracers.push({ line, life: 0.12 });
  }

  number(x: number, y: number, z: number, text: string, color = '#fff') {
    if (this.numbers.length > 60) return;
    const el = document.createElement('div');
    el.className = 'dmg-num';
    el.textContent = text;
    el.style.color = color;
    this.overlay.appendChild(el);
    this.numbers.push({ el, pos: new THREE.Vector3(x + (Math.random() - 0.5) * 0.5, y, z), life: 0 });
  }

  update(dt: number, width: number, height: number) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]!;
      p.life += dt;
      p.vy -= 14 * dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y = Math.max(0.05, p.mesh.position.y + p.vy * dt);
      p.mesh.position.z += p.vz * dt;
      if (p.mesh.position.y <= 0.05) {
        p.vx *= 0.8;
        p.vz *= 0.8;
        p.vy = Math.abs(p.vy) * 0.3;
      }
      p.mesh.rotation.x += p.spin * dt;
      p.mesh.rotation.y += p.spin * dt;
      const k = 1 - p.life / p.max;
      p.mesh.scale.setScalar(Math.max(0.01, k));
      if (p.life >= p.max) {
        this.scene.remove(p.mesh);
        this.particles.splice(i, 1);
      }
    }
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i]!;
      t.life -= dt;
      (t.line.material as THREE.LineBasicMaterial).opacity = Math.max(0, t.life / 0.12);
      if (t.life <= 0) {
        this.scene.remove(t.line);
        t.line.geometry.dispose();
        (t.line.material as THREE.Material).dispose();
        this.tracers.splice(i, 1);
      }
    }
    for (let i = this.numbers.length - 1; i >= 0; i--) {
      const n = this.numbers[i]!;
      n.life += dt;
      n.pos.y += dt * 1.5;
      this.tmp.copy(n.pos).project(this.camera);
      n.el.style.transform = `translate(${((this.tmp.x + 1) / 2) * width}px, ${((1 - this.tmp.y) / 2) * height}px) translate(-50%,-50%) scale(${1 + Math.max(0, 0.3 - n.life)})`;
      n.el.style.opacity = String(Math.max(0, 1 - n.life / 0.9));
      if (n.life > 0.9 || this.tmp.z > 1) {
        n.el.remove();
        this.numbers.splice(i, 1);
      }
    }
  }
}
