import { useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Color, Group, MathUtils, MeshStandardMaterial } from "three";

interface Drone3DProps {
  mode: "RTB" | "EMERGENCY LANDING";
  hasFault: boolean;
  anomaly: number;
}

const nominalColor = new Color("#b9f49a");
const warningColor = new Color("#f0b86c");
const criticalColor = new Color("#e56b59");

function Aircraft({ mode, hasFault, anomaly }: Drone3DProps) {
  const aircraft = useRef<Group>(null);
  const fuselage = useRef<MeshStandardMaterial>(null);
  const flightTime = useRef(0);
  const descent = useRef(0);

  useFrame((_, delta) => {
    if (!aircraft.current || !fuselage.current) return;

    const dt = Math.min(delta, 0.05);
    const severity = MathUtils.clamp(anomaly, 0, 1);
    const emergency = mode === "EMERGENCY LANDING";
    flightTime.current += dt * (emergency ? 1.8 + severity : 0.65 + severity * 0.25);
    descent.current = Math.min(1, descent.current + dt * (emergency ? 0.75 + severity * 0.4 : 0.18));

    const bob = Math.sin(flightTime.current * 1.6) * 0.045;
    const forwardDrift = Math.sin(flightTime.current * 0.5) * 0.13;
    const targetX = (emergency ? 0.44 : -0.34) * descent.current + forwardDrift;
    const targetY = bob - (emergency ? 0.64 : 0.21) * descent.current;
    const response = emergency ? 3.5 : 1.8;

    aircraft.current.position.x = MathUtils.damp(aircraft.current.position.x, targetX, response, dt);
    aircraft.current.position.y = MathUtils.damp(aircraft.current.position.y, targetY, response, dt);
    aircraft.current.rotation.z = MathUtils.damp(aircraft.current.rotation.z, emergency ? -0.42 : 0.24, response, dt);
    aircraft.current.rotation.y = MathUtils.damp(aircraft.current.rotation.y, emergency ? -0.38 : 0.46, response, dt);
    aircraft.current.rotation.x = MathUtils.damp(aircraft.current.rotation.x, emergency ? -0.5 : -0.12, response, dt);

    const targetColor = emergency && hasFault ? (severity > 0.6 ? criticalColor : warningColor) : nominalColor;
    fuselage.current.color.lerp(targetColor, 1 - Math.exp(-dt * 3));
  });

  return (
    <group ref={aircraft} rotation={[-0.12, 0.25, 0.08]}>
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.13, 0.18, 1.5, 6]} />
        <meshStandardMaterial ref={fuselage} color="#b9f49a" roughness={0.55} metalness={0.18} flatShading />
      </mesh>
      <mesh position={[0, 0, -0.87]} rotation={[-Math.PI / 2, 0, 0]}>
        <coneGeometry args={[0.14, 0.42, 6]} />
        <meshStandardMaterial color="#e4eee0" metalness={0.28} roughness={0.5} flatShading />
      </mesh>
      <mesh position={[0, 0.02, -0.03]}>
        <boxGeometry args={[2.25, 0.055, 0.36]} />
        <meshStandardMaterial color="#c9e9d2" metalness={0.16} roughness={0.58} />
      </mesh>
      <mesh position={[0, 0.09, -0.28]}>
        <boxGeometry args={[0.27, 0.095, 0.42]} />
        <meshStandardMaterial color="#426a68" roughness={0.35} metalness={0.22} />
      </mesh>
      <mesh position={[0, 0.03, 0.65]}>
        <boxGeometry args={[0.8, 0.045, 0.19]} />
        <meshStandardMaterial color="#c9e9d2" roughness={0.58} />
      </mesh>
      <mesh position={[0, 0.2, 0.68]}>
        <boxGeometry args={[0.05, 0.38, 0.24]} />
        <meshStandardMaterial color="#b9f49a" roughness={0.58} />
      </mesh>
      <mesh position={[0, 0, -1.1]} rotation={[0, 0, Math.PI / 4]}>
        <boxGeometry args={[0.52, 0.025, 0.025]} />
        <meshStandardMaterial color="#e1ebdc" roughness={0.48} />
      </mesh>
    </group>
  );
}

export default function Drone3D(props: Drone3DProps) {
  return (
    <Canvas
      orthographic
      camera={{ position: [2.6, 2.2, 4.3], zoom: 62, near: 0.1, far: 30 }}
      gl={{ alpha: true, antialias: true }}
      style={{ background: "transparent" }}
      aria-label={`3D aircraft flying ${props.mode === "RTB" ? "toward base" : "toward an emergency landing"}`}
      role="img"
    >
      <ambientLight intensity={1.8} />
      <directionalLight position={[-3, 5, 4]} intensity={2.2} />
      <Aircraft {...props} />
    </Canvas>
  );
}
