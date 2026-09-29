import * as T from "three";
import { MAJOR_PARTS, type EnginePartId } from "./engineParts";
import type { PartState } from "./engineTelemetry";

export function getCompIdForMesh(mesh: T.Object3D): EnginePartId {
  for (let node: T.Object3D | null = mesh; node; node = node.parent) {
    const name = node.name;
    if (/^Cylinder_\d+_(Head|Valve_Cover)/.test(name)) return "heads";
    if (/^Cylinder_\d+_Fins/.test(name)) return "fins";
    if (/^Intake|^Throttle|^Air_Inlet/.test(name)) return "manifold";
    if (/^Exhaust/.test(name)) return "exhaust";
    if (/^Oil_/.test(name)) return "oil";
    if (/^Fuel_/.test(name)) return "fuel";
    if (/^ECU|^Harness|^Ignition/.test(name)) return "ecu";
    if (/^Gearbox|^Pinion|^Reduction/.test(name)) return "gearbox";
    if (/^Output_Shaft|^Crank|^Piston|^ConnectingRod/.test(name) && !/^Crankcase/.test(name)) return "shaft";
    if (/^Propeller|^Blade/.test(name)) return "propeller";
    const cylinder = name.match(/^(?:Cylinder|CHT_Sensor|EGT_Sensor)_(\d)/);
    if (cylinder) return `cyl-${cylinder[1]}` as EnginePartId;
  }
  return "crankcase";
}

export type RegisteredPart = {
  id: EnginePartId; meshes: T.Mesh[]; materials: T.MeshStandardMaterial[];
  anchor: T.Vector3; offset: T.Vector3; state: PartState; selected: boolean;
};
export function createComponentRegistry(root: T.Group) {
  const parts: RegisteredPart[] = MAJOR_PARTS.map(part => ({ id: part.id, meshes: [], materials: [], anchor: new T.Vector3(...part.pos), offset: new T.Vector3(), state: "UNAVAILABLE", selected: false }));
  const map = new Map(parts.map(part => [part.id, part]));
  const clones = new Map<string, T.MeshStandardMaterial>();
  const movable: { mesh: T.Mesh; base: T.Vector3; offset: T.Vector3 }[] = [];
  const pickable: T.Mesh[] = [];
  const world = new T.Vector3(), rotation = new T.Quaternion();
  root.updateMatrixWorld(true);
  root.traverse(object => {
    if (!(object instanceof T.Mesh)) return;
    const id = getCompIdForMesh(object), part = map.get(id)!;
    object.userData.partId = id;
    const original = object.material as T.MeshStandardMaterial;
    const key = `${id}:${original.uuid}`;
    let material = clones.get(key);
    if (!material) { material = original.clone(); clones.set(key, material); part.materials.push(material); }
    object.material = material;
    part.meshes.push(object); pickable.push(object);
    object.getWorldPosition(world);
    const offset = explodeOffset(id, world.x);
    object.parent!.getWorldQuaternion(rotation).invert();
    offset.applyQuaternion(rotation);
    movable.push({ mesh: object, base: object.position.clone(), offset });
  });
  for (const part of parts) part.offset.copy(explodeOffset(part.id, part.anchor.x));
  return { parts, map, movable, pickable };
}
function explodeOffset(id: EnginePartId, x: number) {
  const side = x < 0 ? -1 : 1;
  if (id.startsWith("cyl-")) return new T.Vector3(side * .2, 0, 0);
  if (id === "heads") return new T.Vector3(side * .34, .04, 0);
  if (id === "fins") return new T.Vector3(side * .22, -.04, 0);
  if (id === "manifold") return new T.Vector3(0, .24, 0);
  if (id === "fuel") return new T.Vector3(0, .36, -.06);
  if (id === "exhaust") return new T.Vector3(0, -.22, -.08);
  if (id === "oil") return new T.Vector3(.12, -.2, 0);
  if (id === "ecu") return new T.Vector3(-.12, .08, -.22);
  if (id === "gearbox") return new T.Vector3(0, 0, .18);
  if (id === "shaft") return new T.Vector3(0, 0, .28);
  if (id === "propeller") return new T.Vector3(0, 0, .4);
  return new T.Vector3();
}
