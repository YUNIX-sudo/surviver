// Renderer, camera, lights, ground and arena decoration.

import * as THREE from 'three';
import { CELL_SIZE, MAP_HALF, mulberry32 } from '@surviver/shared';

export class SceneSetup {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  readonly ground: THREE.Mesh;
  readonly grid: THREE.LineSegments;
  zoom = 0.85;
  private shake = 0;
  private camTarget = new THREE.Vector3();

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    const sky = 0x9fd3f0;
    this.scene.background = new THREE.Color(sky);
    this.scene.fog = new THREE.Fog(sky, 55, 120);

    this.camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, 300);
    this.camera.position.set(0, 20, 16);

    this.scene.add(new THREE.HemisphereLight(0xdff3ff, 0x5a7a3a, 1.4));
    this.sun = new THREE.DirectionalLight(0xfff1d6, 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -32;
    sc.right = sc.top = 32;
    sc.near = 1;
    sc.far = 120;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun, this.sun.target);

    this.ground = this.makeGround();
    this.scene.add(this.ground);
    this.decorate();

    // build grid overlay (visible in build mode)
    const gridGeo = new THREE.BufferGeometry();
    const pts: number[] = [];
    for (let v = -MAP_HALF; v <= MAP_HALF; v += CELL_SIZE) {
      pts.push(v, 0.03, -MAP_HALF, v, 0.03, MAP_HALF, -MAP_HALF, 0.03, v, MAP_HALF, 0.03, v);
    }
    gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.grid = new THREE.LineSegments(gridGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12 }));
    this.grid.visible = false;
    this.scene.add(this.grid);

    window.addEventListener('resize', () => this.resize(container));
  }

  private makeGround() {
    const size = MAP_HALF * 2 + 60;
    const g = new THREE.PlaneGeometry(size, size, 80, 80);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position!;
    const colors: number[] = [];
    const rnd = mulberry32(7);
    const inner = new THREE.Color(0x6aa84f);
    const inner2 = new THREE.Color(0x7cb85a);
    const outer = new THREE.Color(0x4f6e3a);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const outside = Math.max(Math.abs(x), Math.abs(z)) > MAP_HALF;
      if (outside) pos.setY(i, (rnd() - 0.3) * 0.6 + (Math.max(Math.abs(x), Math.abs(z)) - MAP_HALF) * 0.08);
      c.copy(outside ? outer : inner).lerp(inner2, outside ? 0 : rnd() * 0.8);
      const d = Math.hypot(x, z);
      if (d < 7) c.lerp(new THREE.Color(0xb59b6a), (1 - d / 7) * 0.6); // trampled dirt around the Core
      colors.push(c.r, c.g, c.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 }));
    mesh.receiveShadow = true;
    return mesh;
  }

  private decorate() {
    // fence posts on the arena border
    const postGeo = new THREE.BoxGeometry(0.25, 1.1, 0.25);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x6f4422, flatShading: true });
    const n = 4 * (MAP_HALF * 2) / 4;
    const posts = new THREE.InstancedMesh(postGeo, postMat, n);
    const m = new THREE.Matrix4();
    let i = 0;
    for (let v = -MAP_HALF; v < MAP_HALF; v += 4) {
      for (const [x, z] of [
        [v, -MAP_HALF],
        [MAP_HALF, v],
        [-v, MAP_HALF],
        [-MAP_HALF, -v],
      ] as const) {
        if (i >= n) break;
        m.makeTranslation(x, 0.55, z);
        posts.setMatrixAt(i++, m);
      }
    }
    posts.castShadow = true;
    this.scene.add(posts);
    // grass tufts
    const rnd = mulberry32(99);
    const tuftGeo = new THREE.ConeGeometry(0.08, 0.35, 3);
    const tuftMat = new THREE.MeshStandardMaterial({ color: 0x4e8f3a, flatShading: true });
    const count = 900;
    const tufts = new THREE.InstancedMesh(tuftGeo, tuftMat, count);
    for (let j = 0; j < count; j++) {
      const x = (rnd() - 0.5) * MAP_HALF * 2;
      const z = (rnd() - 0.5) * MAP_HALF * 2;
      if (Math.hypot(x, z) < 6) {
        m.makeTranslation(1000, -10, 0);
      } else m.makeRotationZ((rnd() - 0.5) * 0.5).setPosition(x, 0.15, z);
      tufts.setMatrixAt(j, m);
    }
    this.scene.add(tufts);
  }

  resize(container: HTMLElement) {
    this.camera.aspect = container.clientWidth / container.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(container.clientWidth, container.clientHeight);
  }

  addShake(v: number) {
    this.shake = Math.min(1, this.shake + v);
  }

  /** Smooth third-person follow camera. */
  follow(x: number, z: number, dt: number) {
    this.camTarget.lerp(new THREE.Vector3(x, 0, z), 1 - Math.exp(-dt * 8));
    const dist = 22 * this.zoom;
    const t = this.camTarget;
    this.shake = Math.max(0, this.shake - dt * 2.5);
    const sx = (Math.random() - 0.5) * this.shake * 0.6;
    const sz = (Math.random() - 0.5) * this.shake * 0.6;
    this.camera.position.set(t.x + sx, dist * 0.82, t.z + dist * 0.62 + sz);
    this.camera.lookAt(t.x, 0.5, t.z);
    this.sun.position.set(t.x + 18, 40, t.z + 10);
    this.sun.target.position.set(t.x, 0, t.z);
  }

  snapCamera(x: number, z: number) {
    this.camTarget.set(x, 0, z);
  }
}
