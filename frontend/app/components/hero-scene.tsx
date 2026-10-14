'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export default function HeroScene() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
    camera.position.set(0, 0, 7.8);

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, window.innerWidth < 768 ? 1.5 : 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    host.appendChild(renderer.domElement);

    const centerpiece = new THREE.Group();
    const crystal = new THREE.Group();
    scene.add(centerpiece);
    centerpiece.add(crystal);

    const glassGeometry = new RoundedBoxGeometry(2.05, 2.05, 2.05, 5, 0.12);
    const glass = new THREE.Mesh(
      glassGeometry,
      new THREE.MeshPhysicalMaterial({
        color: 0x50e9b6,
        metalness: 0.18,
        roughness: 0.18,
        transmission: 0.55,
        thickness: 1.2,
        clearcoat: 1,
        clearcoatRoughness: 0.12,
        transparent: true,
        opacity: 0.62,
      }),
    );
    crystal.add(glass);

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(glassGeometry),
      new THREE.LineBasicMaterial({ color: 0xd4fff0, transparent: true, opacity: 0.72 }),
    );
    crystal.add(edges);

    const core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.62, 2),
      new THREE.MeshStandardMaterial({
        color: 0x4ceab5,
        emissive: 0x10c99e,
        emissiveIntensity: 2.5,
        metalness: 0.25,
        roughness: 0.24,
      }),
    );
    crystal.add(core);

    const mintRing = new THREE.Mesh(
      new THREE.TorusGeometry(1.62, 0.012, 8, 160),
      new THREE.MeshBasicMaterial({ color: 0x68f4c4, transparent: true, opacity: 0.62 }),
    );
    mintRing.rotation.set(0.84, 0.22, -0.32);
    centerpiece.add(mintRing);

    const tealRing = new THREE.Mesh(
      new THREE.TorusGeometry(1.88, 0.008, 8, 160),
      new THREE.MeshBasicMaterial({ color: 0x20c9c2, transparent: true, opacity: 0.48 }),
    );
    tealRing.rotation.set(-0.62, 0.6, 0.38);
    centerpiece.add(tealRing);

    scene.add(new THREE.AmbientLight(0xd4e6dc, 1.2));

    const mintLight = new THREE.PointLight(0x62f2ba, 32, 14);
    mintLight.position.set(2.8, 2.4, 3.8);
    scene.add(mintLight);

    const tealLight = new THREE.PointLight(0x18c8c1, 26, 12);
    tealLight.position.set(-3, -1.5, 2);
    scene.add(tealLight);

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let inView = false;
    const resizeObserver = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (!width || !height) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      renderer.render(scene, camera);
    });
    resizeObserver.observe(host);

    let frameId = 0;
    let animationRunning = false;
    const startedAt = performance.now();
    const renderFrame = () => {
      const elapsed = (performance.now() - startedAt) / 1000;
      crystal.rotation.y = elapsed * 0.16;
      crystal.rotation.x = Math.sin(elapsed * 0.22) * 0.1;
      centerpiece.rotation.y = Math.sin(elapsed * 0.12) * 0.08;
      mintRing.rotation.z += 0.0007;
      tealRing.rotation.y += 0.0005;
      renderer.render(scene, camera);
      frameId = window.requestAnimationFrame(renderFrame);
    };
    const startAnimation = () => {
      if (animationRunning || !inView || document.hidden || reducedMotion.matches) return;
      animationRunning = true;
      frameId = window.requestAnimationFrame(renderFrame);
    };
    const stopAnimation = (renderStill = false) => {
      animationRunning = false;
      window.cancelAnimationFrame(frameId);
      if (renderStill) renderer.render(scene, camera);
    };
    renderer.render(scene, camera);

    const visibilityObserver = typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver(([entry]) => {
        inView = entry.isIntersecting;
        host.classList.toggle('is-visible', inView);
        if (inView) startAnimation();
        else stopAnimation();
      }, { rootMargin: '80px' });
    if (visibilityObserver) visibilityObserver.observe(host);
    else {
      inView = true;
      startAnimation();
    }

    const handleVisibilityChange = () => {
      if (document.hidden) stopAnimation();
      else startAnimation();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const handleMotionChange = () => {
      if (reducedMotion.matches) stopAnimation(true);
      else startAnimation();
    };
    reducedMotion.addEventListener('change', handleMotionChange);

    return () => {
      animationRunning = false;
      window.cancelAnimationFrame(frameId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      reducedMotion.removeEventListener('change', handleMotionChange);
      visibilityObserver?.disconnect();
      resizeObserver.disconnect();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose());
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div ref={hostRef} className="cube-scene" aria-hidden="true" />;
}