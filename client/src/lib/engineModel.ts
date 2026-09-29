import * as T from "three";
export { MAJOR_PARTS } from "./engineParts";

const createMat = (params: T.MeshStandardMaterialParameters) =>
  new T.MeshStandardMaterial(params);

// Procedural subtle carbon fiber normal/bump texture for the propeller
const makeCarbonTexture = () => {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("Canvas textures unavailable");
  ctx.fillStyle = "#1c1f24";
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = "#121417";
  for (let x = 0; x < 64; x += 8) {
    for (let y = 0; y < 64; y += 8) {
      if ((x / 8 + y / 8) % 2 === 0) {
        ctx.fillRect(x, y, 8, 8);
      }
    }
  }
  const tex = new T.CanvasTexture(c);
  tex.colorSpace = T.SRGBColorSpace;
  tex.wrapS = T.RepeatWrapping;
  tex.wrapT = T.RepeatWrapping;
  tex.repeat.set(4, 20);
  return tex;
};
export function createAeroMats() {
  const carbonTex = makeCarbonTexture();

  const AeroMats = {
    // Crankcase: brushed aluminium
    crankcase: createMat({
      color: 0xbbc2cb,
      metalness: 0.88,
      roughness: 0.32,
      name: "Brushed Aluminium",
    }),
    // Cylinders: dark graphite
    cylinders: createMat({
      color: 0x22262c,
      metalness: 0.72,
      roughness: 0.42,
      name: "Dark Graphite",
    }),
    // Cooling fins: black graphite
    coolingFins: createMat({
      color: 0x14161a,
      metalness: 0.65,
      roughness: 0.55,
      side: T.DoubleSide,
      name: "Black Graphite",
    }),
    // Cylinder heads: silver aluminium
    cylinderHeads: createMat({
      color: 0xd6dbe1,
      metalness: 0.92,
      roughness: 0.24,
      side: T.DoubleSide,
      name: "Silver Aluminium",
    }),
    // Intake: metallic grey
    intake: createMat({
      color: 0x6e7682,
      metalness: 0.82,
      roughness: 0.35,
      name: "Metallic Grey",
    }),
    // Exhaust: dark bronze/copper
    exhaust: createMat({
      color: 0x8c5232,
      metalness: 0.88,
      roughness: 0.38,
      name: "Dark Bronze / Copper",
    }),
    // Oil lines: dark metallic
    oilLines: createMat({
      color: 0x3d434d,
      metalness: 0.9,
      roughness: 0.28,
      name: "Dark Metallic Steel",
    }),
    // Fuel lines: dark grey/blue
    fuelLines: createMat({
      color: 0x2a3d54,
      metalness: 0.78,
      roughness: 0.35,
      name: "Aero Blue Steel",
    }),
    // ECU / wiring: black/dark charcoal
    ecuWiring: createMat({
      color: 0x121418,
      metalness: 0.15,
      roughness: 0.85,
      name: "Dark Charcoal Polymer",
    }),
    // Gearbox: gunmetal
    gearbox: createMat({
      color: 0x484e56,
      metalness: 0.9,
      roughness: 0.3,
      name: "Gunmetal Alloy",
    }),
    // Propeller: carbon-fibre black
    propeller: createMat({
      color: 0x181a1e,
      map: carbonTex,
      metalness: 0.45,
      roughness: 0.3,
      name: "Carbon-Fibre Composite",
    }),
    // Output shaft & internal mechanicals
    shaft: createMat({
      color: 0xd8dde4,
      metalness: 0.98,
      roughness: 0.18,
      name: "High-Tensile Steel",
    }),
    // Ceramic spark plugs
    ceramic: createMat({
      color: 0xe5e5e0,
      metalness: 0.05,
      roughness: 0.25,
    }),
  };

  return AeroMats;
}
export function buildAeroEngineModel(
  AeroMats: ReturnType<typeof createAeroMats>
) {
  const P = Math.PI,
    root = new T.Group();
  root.name = "AeroPistonEngine";

  const add = (
    p: T.Object3D,
    g: T.BufferGeometry,
    m: T.MeshStandardMaterial,
    n: string,
    x = 0,
    y = 0,
    z = 0
  ) => {
    const o = new T.Mesh(g, m);
    o.name = n;
    o.position.set(x, y, z);
    p.add(o);
    return o;
  };
  const grp = (p: T.Object3D, n: string, x = 0, y = 0, z = 0) => {
    const g = new T.Group();
    g.name = n;
    g.position.set(x, y, z);
    p.add(g);
    return g;
  };

  const cx = (r: number, l: number, s = 32, r2 = r) =>
    new T.CylinderGeometry(r2, r, l, s).rotateZ(-P / 2);
  const cz = (r: number, l: number, s = 32, r2 = r) =>
    new T.CylinderGeometry(r2, r, l, s).rotateX(P / 2);
  const cy = (r: number, l: number, s = 24) =>
    new T.CylinderGeometry(r, r, l, s);
  const bx = (a: number, b: number, c: number) => new T.BoxGeometry(a, b, c);
  const tube = (
    p: T.Object3D,
    pts: number[][],
    r: number,
    m: T.MeshStandardMaterial,
    n: string,
    seg = 32
  ) =>
    add(
      p,
      new T.TubeGeometry(
        new T.CatmullRomCurve3(pts.map(a => new T.Vector3(a[0], a[1], a[2]))),
        seg,
        r,
        8,
        false
      ),
      m,
      n
    );

  const finned = (
    rc: number,
    rf: number,
    x0: number,
    x1: number,
    pt = 0.0085
  ) => {
    const pts = [new T.Vector2(rc, x0)];
    for (let y = x0; y + pt <= x1; y += pt) {
      pts.push(
        new T.Vector2(rc, y + 0.002),
        new T.Vector2(rf, y + 0.0025),
        new T.Vector2(rf, y + 0.0055),
        new T.Vector2(rc, y + 0.006)
      );
    }
    pts.push(new T.Vector2(rc, x1));
    return new T.LatheGeometry(pts, 40).rotateZ(-P / 2);
  };

  const bg = {
    x: cx(0.0045, 0.006, 6),
    y: cy(0.0045, 0.006),
    z: cz(0.0045, 0.006, 6),
  };
  const ring = (
    p: T.Object3D,
    a: "x" | "z",
    c: number[],
    r: number,
    n: number
  ) => {
    for (let k = 0; k < n; k++) {
      const u = r * Math.cos((k / n) * 2 * P),
        v = r * Math.sin((k / n) * 2 * P);
      const q =
        a === "x" ? [c[0], c[1] + u, c[2] + v] : [c[0] + u, c[1] + v, c[2]];
      add(p, bg[a], AeroMats.shaft, "Bolt", q[0], q[1], q[2]);
    }
  };

  const sens: T.Object3D[] = [];

  /* Crankcase & Sump */
  add(
    root,
    bx(0.069, 0.15, 0.34),
    AeroMats.crankcase,
    "Crankcase_Right",
    0.035
  );
  add(
    root,
    bx(0.069, 0.15, 0.34),
    AeroMats.crankcase,
    "Crankcase_Left",
    -0.035
  );
  add(
    root,
    bx(0.15, 0.152, 0.01),
    AeroMats.crankcase,
    "Crankcase_Rear_Plate",
    0,
    0,
    -0.175
  );
  add(
    root,
    bx(0.15, 0.152, 0.01),
    AeroMats.crankcase,
    "Crankcase_Front_Plate",
    0,
    0,
    0.175
  );
  ring(root, "z", [0, 0, -0.181], 0.058, 6);

  add(root, bx(0.14, 0.06, 0.32), AeroMats.crankcase, "Oil_Sump", 0, -0.105, 0);
  add(
    root,
    bx(0.15, 0.006, 0.33),
    AeroMats.crankcase,
    "Oil_Sump_Flange",
    0,
    -0.075,
    0
  );
  add(
    root,
    cy(0.007, 0.01, 6),
    AeroMats.shaft,
    "Sump_Drain_Plug",
    0,
    -0.139,
    0
  );

  const ot = add(
    root,
    cx(0.007, 0.03, 12),
    AeroMats.oilLines,
    "Oil_Temp_Sensor",
    0.085,
    -0.105,
    0.06
  );
  sens.push(ot);
  const vs = add(
    root,
    bx(0.03, 0.02, 0.03),
    AeroMats.ecuWiring,
    "Vibration_Sensor",
    0,
    0.085,
    0.16
  );
  sens.push(vs);
  add(
    root,
    cy(0.006, 0.006, 6),
    AeroMats.shaft,
    "Vibration_Sensor_Bolt",
    0,
    0.097,
    0.16
  );
  const cps = add(
    root,
    cy(0.008, 0.03),
    AeroMats.ecuWiring,
    "Crank_Position_Sensor",
    0,
    0.1,
    0.205
  );
  sens.push(cps);

  /* Crankshaft */
  const C = [
    { s: 1, z: -0.12, th: 0 },
    { s: -1, z: -0.04, th: P },
    { s: 1, z: 0.04, th: P },
    { s: -1, z: 0.12, th: 0 },
  ];
  const R = 0.03,
    L = 0.11;
  const crank = grp(root, "Crankshaft");
  add(
    crank,
    cz(0.02, 0.42, 32),
    AeroMats.shaft,
    "Crank_Main_Journal",
    0,
    0,
    0.04
  );

  C.forEach((c, i) => {
    const n = i + 1,
      ca = Math.cos(c.th),
      sa = Math.sin(c.th);
    add(
      crank,
      cz(0.017, 0.05, 24),
      AeroMats.shaft,
      `Crank_Pin_${n}`,
      R * ca,
      R * sa,
      c.z
    );
    [-1, 1].forEach(q => {
      const w = add(
        crank,
        bx(0.07, 0.034, 0.008),
        AeroMats.shaft,
        `Crank_Web_${n}${q < 0 ? "A" : "B"}`,
        0.006 * ca,
        0.006 * sa,
        c.z + q * 0.03
      );
      w.rotation.z = c.th;
    });
  });

  /* Cylinders, Pistons, Connecting Rods */
  const pist: T.Group[] = [],
    rods: T.Group[] = [];
  C.forEach((c, i) => {
    const n = i + 1,
      s = c.s,
      g = grp(root, "Cylinder_" + n, 0, 0, c.z);
    if (s < 0) g.rotation.y = P;

    add(
      g,
      cx(0.047, 0.115),
      AeroMats.cylinders,
      `Cylinder_${n}_Barrel`,
      0.1275
    );
    // Cylinders: dark graphite barrel with black graphite cooling fins
    add(
      g,
      finned(0.047, 0.064, 0.07, 0.185),
      AeroMats.coolingFins,
      `Cylinder_${n}_Fins`
    );
    add(
      g,
      cx(0.058, 0.008),
      AeroMats.cylinders,
      `Cylinder_${n}_Base_Flange`,
      0.073
    );
    // Cylinder heads: silver aluminium
    add(
      g,
      finned(0.056, 0.068, 0.185, 0.25),
      AeroMats.cylinderHeads,
      `Cylinder_${n}_Head`
    );
    add(
      g,
      bx(0.045, 0.028, 0.075),
      AeroMats.cylinderHeads,
      `Cylinder_${n}_Valve_Cover`,
      0.235,
      0.078,
      0
    );
    add(
      g,
      bx(0.028, 0.024, 0.04),
      AeroMats.ecuWiring,
      `Ignition_Coil_${n}`,
      0.235,
      0.104,
      0
    );
    add(
      g,
      cy(0.02, 0.006),
      AeroMats.intake,
      `Intake_Flange_${n}`,
      0.195,
      0.069,
      0
    );
    add(
      g,
      cy(0.02, 0.006),
      AeroMats.exhaust,
      `Exhaust_Flange_${n}`,
      0.195,
      -0.069,
      0
    );
    ring(g, "x", [0.079, 0, 0], 0.052, 6);

    const ch = add(
      g,
      cz(0.005, 0.02, 12),
      AeroMats.ecuWiring,
      `CHT_Sensor_${n}`,
      0.235,
      -0.03,
      0.081
    );
    sens.push(ch);

    [-1, 1].forEach(q => {
      const pg = grp(g, `Spark_Plug_${n}${q < 0 ? "A" : "B"}`, 0.212, 0.02, 0);
      add(
        pg,
        cz(0.0075, 0.012, 6),
        AeroMats.shaft,
        "Plug_Hex",
        0,
        0,
        q * 0.074
      );
      add(
        pg,
        cz(0.0055, 0.03, 16),
        AeroMats.ceramic,
        "Plug_Ceramic",
        0,
        0,
        q * 0.095
      );
      add(
        pg,
        cz(0.0075, 0.01, 12),
        AeroMats.ecuWiring,
        "Plug_Cap",
        0,
        0,
        q * 0.114
      );
      tube(
        g,
        [
          [0.235, 0.104, q * 0.012],
          [0.238, 0.078, q * 0.09],
          [0.212, 0.02, q * 0.121],
        ],
        0.0025,
        AeroMats.ecuWiring,
        `Ignition_Lead_${n}${q < 0 ? "A" : "B"}`,
        20
      );
    });

    /* Piston */
    const pg = grp(root, "Piston_" + n);
    add(
      pg,
      cx(0.041, 0.05),
      AeroMats.cylinderHeads,
      `Piston_${n}_Body`,
      s * 0.012
    );
    [0.03, 0.038].forEach((d, k) => {
      add(
        pg,
        new T.TorusGeometry(0.0415, 0.0018, 6, 28).rotateY(P / 2),
        AeroMats.shaft,
        `Piston_${n}_Ring${k + 1}`,
        s * d
      );
    });
    add(pg, cz(0.009, 0.062, 16), AeroMats.shaft, `Piston_${n}_Wrist_Pin`);
    pist.push(pg);

    /* Connecting rod */
    const rg = grp(root, "ConnectingRod_" + n);
    add(
      rg,
      bx(L - 0.036, 0.016, 0.009),
      AeroMats.shaft,
      `ConnectingRod_${n}_Beam`,
      L / 2
    );
    add(rg, cz(0.024, 0.02, 24), AeroMats.shaft, `ConnectingRod_${n}_BigEnd`);
    add(
      rg,
      cz(0.012, 0.014, 16),
      AeroMats.shaft,
      `ConnectingRod_${n}_SmallEnd`,
      L
    );
    rods.push(rg);

    /* Intake runner + injector */
    tube(
      root,
      [
        [0, 0.12, c.z],
        [s * 0.05, 0.14, c.z],
        [s * 0.13, 0.13, c.z],
        [s * 0.19, 0.105, c.z],
        [s * 0.195, 0.068, c.z],
      ],
      0.014,
      AeroMats.intake,
      `Intake_Runner_${n}`,
      32
    );
    add(
      root,
      cy(0.009, 0.04),
      AeroMats.fuelLines,
      `Fuel_Injector_${n}`,
      s * 0.16,
      0.14,
      c.z
    );

    /* Exhaust runner + EGT sensor */
    tube(
      root,
      [
        [s * 0.195, -0.068, c.z],
        [s * 0.205, -0.11, c.z],
        [s * 0.19, -0.15, c.z],
        [s * 0.14, -0.168, c.z],
      ],
      0.016,
      AeroMats.exhaust,
      `Exhaust_Runner_${n}`,
      32
    );
    const eg = add(
      root,
      cx(0.005, 0.03, 12, 0.005),
      AeroMats.ecuWiring,
      `EGT_Sensor_${n}`,
      s * 0.226,
      -0.11,
      c.z
    );
    sens.push(eg);
    if (s < 0) eg.rotation.z = P;
  });

  /* Intake System */
  add(root, cz(0.028, 0.29), AeroMats.intake, "Intake_Plenum", 0, 0.12, -0.005);
  add(root, cz(0.032, 0.04), AeroMats.intake, "Throttle_Body", 0, 0.12, -0.17);
  add(
    root,
    cz(0.036, 0.08),
    AeroMats.ecuWiring,
    "Air_Inlet_Hose",
    0,
    0.12,
    -0.23
  );

  /* Fuel System: Dark Grey/Blue lines */
  [1, -1].forEach(s => {
    const zs = C.filter(c => c.s === s).map(c => c.z);
    tube(
      root,
      [
        [s * 0.16, 0.165, -0.185],
        [s * 0.16, 0.165, Math.max(...zs) + 0.02],
      ],
      0.007,
      AeroMats.fuelLines,
      `Fuel_Rail_${s > 0 ? "R" : "L"}`,
      4
    );
  });
  tube(
    root,
    [
      [0.16, 0.165, -0.185],
      [0.1, 0.19, -0.185],
      [-0.1, 0.19, -0.185],
      [-0.16, 0.165, -0.185],
    ],
    0.005,
    AeroMats.fuelLines,
    "Fuel_Crossover",
    24
  );
  tube(
    root,
    [
      [0, 0.19, -0.185],
      [0.02, 0.19, -0.24],
      [0.06, 0.13, -0.25],
      [0.09, 0.105, -0.25],
    ],
    0.005,
    AeroMats.fuelLines,
    "Fuel_Supply_Line",
    24
  );
  add(
    root,
    cz(0.028, 0.08),
    AeroMats.fuelLines,
    "Fuel_Pump",
    0.09,
    0.08,
    -0.25
  );
  tube(
    root,
    [
      [0.09, 0.08, -0.29],
      [0.09, 0.08, -0.36],
    ],
    0.005,
    AeroMats.fuelLines,
    "Fuel_Inlet_Line",
    6
  );
  add(
    root,
    cy(0.014, 0.03),
    AeroMats.fuelLines,
    "Fuel_Pressure_Regulator",
    -0.16,
    0.185,
    -0.185
  );

  /* Exhaust: Dark Bronze / Copper */
  [1, -1].forEach(s => {
    const zm = Math.max(...C.filter(c => c.s === s).map(c => c.z));
    tube(
      root,
      [
        [s * 0.14, -0.168, zm],
        [s * 0.14, -0.168, -0.2],
        [s * 0.12, -0.168, -0.29],
        [s * 0.03, -0.168, -0.315],
      ],
      0.02,
      AeroMats.exhaust,
      `Exhaust_Collector_${s > 0 ? "R" : "L"}`,
      40
    );
  });
  add(
    root,
    cz(0.042, 0.13, 32),
    AeroMats.exhaust,
    "Exhaust_Muffler",
    0,
    -0.168,
    -0.375
  );
  add(
    root,
    cz(0.022, 0.09),
    AeroMats.exhaust,
    "Exhaust_Tailpipe",
    0,
    -0.168,
    -0.48
  );

  /* Oil System: Dark Metallic */
  add(
    root,
    bx(0.08, 0.05, 0.05),
    AeroMats.oilLines,
    "Oil_Pump",
    0,
    -0.06,
    -0.2
  );
  add(
    root,
    cz(0.038, 0.1),
    AeroMats.oilLines,
    "Oil_Filter",
    0.09,
    -0.05,
    -0.23
  );
  tube(
    root,
    [
      [0.04, -0.06, -0.2],
      [0.07, -0.06, -0.21],
      [0.09, -0.08, -0.23],
    ],
    0.006,
    AeroMats.oilLines,
    "Oil_Line_Pump_Filter",
    16
  );
  tube(
    root,
    [
      [0.09, -0.02, -0.28],
      [0.1, 0.0, -0.22],
      [0.06, 0.02, -0.18],
    ],
    0.006,
    AeroMats.oilLines,
    "Oil_Line_Filter_Gallery",
    16
  );
  const ops = add(
    root,
    cz(0.007, 0.03, 12),
    AeroMats.oilLines,
    "Oil_Pressure_Sensor",
    0.05,
    0.035,
    -0.195
  );
  sens.push(ops);
  tube(
    root,
    [
      [0.06, 0.02, -0.18],
      [0.055, 0.03, -0.185],
    ],
    0.004,
    AeroMats.oilLines,
    "Oil_Line_Sensor",
    4
  );

  /* Gearbox: Gunmetal */
  add(
    root,
    cz(0.09, 0.07, 40),
    AeroMats.gearbox,
    "Gearbox_Housing",
    0,
    0,
    0.21
  );
  add(
    root,
    cz(0.08, 0.016, 40),
    AeroMats.gearbox,
    "Gearbox_Cover",
    0,
    0,
    0.253
  );
  ring(root, "z", [0, 0, 0.263], 0.068, 8);
  add(root, cz(0.03, 0.03, 24), AeroMats.shaft, "Pinion_Gear", 0, 0, 0.19);
  const rg2 = add(
    root,
    cz(0.07, 0.03, 48),
    AeroMats.shaft,
    "Reduction_Gear",
    0,
    0,
    0.225
  );

  /* Output shaft & Propeller */
  const shaft = add(
    root,
    cz(0.022, 0.13, 32),
    AeroMats.shaft,
    "Output_Shaft",
    0,
    0,
    0.26
  );
  const prop = grp(root, "Propeller", 0, 0, 0.335);
  add(prop, cz(0.055, 0.03), AeroMats.gearbox, "Propeller_Hub", 0, 0, 0);
  ring(prop, "z", [0, 0, 0.016], 0.042, 6);
  add(
    prop,
    cz(0.055, 0.09, 32, 0.006),
    AeroMats.propeller,
    "Propeller_Spinner",
    0,
    0,
    0.06
  );

  const bgeo = new T.BoxGeometry(0.09, 0.6, 0.012, 4, 16, 1);
  const pa = bgeo.attributes.position;
  for (let i = 0; i < pa.count; i++) {
    const t = (pa.getY(i) + 0.3) / 0.6;
    const x = pa.getX(i) * (1 - 0.45 * t);
    const ph = 0.75 * (1 - t) - 0.1;
    const z =
      pa.getZ(i) * (1 - 0.5 * t) * (1 - (0.85 * Math.abs(pa.getX(i))) / 0.045);
    pa.setXYZ(
      i,
      x * Math.cos(ph) + z * Math.sin(ph),
      pa.getY(i),
      -x * Math.sin(ph) + z * Math.cos(ph)
    );
  }
  bgeo.translate(0, 0.34, 0);
  bgeo.computeVertexNormals();

  for (let k = 0; k < 3; k++) {
    const b = grp(prop, "Blade_" + (k + 1));
    b.rotation.z = (k * 2 * P) / 3;
    add(b, bgeo, AeroMats.propeller, `Blade_${k + 1}_Airfoil`);
    add(
      b,
      cy(0.016, 0.05),
      AeroMats.gearbox,
      `Blade_${k + 1}_Root_Cuff`,
      0,
      0.055,
      0
    );
  }

  /* Mount frame & ECU: Black/Dark Charcoal */
  const fy = [-0.2, 0.17];
  [
    [0, fy[1], 0.34, 0.014],
    [0, fy[0], 0.34, 0.014],
  ].forEach((b, i) =>
    add(
      root,
      bx(b[2], b[3], 0.014),
      AeroMats.ecuWiring,
      "Mount_Frame_" + (i ? "Bottom" : "Top"),
      b[0],
      b[1],
      -0.2
    )
  );
  [-1, 1].forEach(s => {
    add(
      root,
      bx(0.014, 0.384, 0.014),
      AeroMats.ecuWiring,
      "Mount_Frame_" + (s > 0 ? "Right" : "Left"),
      s * 0.17,
      -0.015,
      -0.2
    );
    fy.forEach((y, k) => {
      add(
        root,
        cz(0.02, 0.03, 20),
        AeroMats.ecuWiring,
        `Mount_Isolator_${s > 0 ? "R" : "L"}${k ? "T" : "B"}`,
        s * 0.17,
        y,
        -0.225
      );
      tube(
        root,
        [
          [s * 0.06, y > 0 ? 0.06 : -0.06, -0.175],
          [s * 0.11, y * 0.6, -0.19],
          [s * 0.17, y, -0.2],
        ],
        0.01,
        AeroMats.ecuWiring,
        `Mount_Arm_${s > 0 ? "R" : "L"}${k ? "T" : "B"}`,
        12
      );
    });
  });

  add(
    root,
    bx(0.12, 0.075, 0.045),
    AeroMats.ecuWiring,
    "ECU",
    -0.085,
    0.01,
    -0.25
  );
  add(
    root,
    bx(0.124, 0.005, 0.05),
    AeroMats.crankcase,
    "ECU_Lid",
    -0.085,
    0.0475,
    -0.25
  );
  [-0.115, -0.055].forEach((x, i) =>
    add(
      root,
      bx(0.03, 0.028, 0.012),
      AeroMats.ecuWiring,
      "ECU_Connector_" + "AB"[i],
      x,
      0.01,
      -0.2215
    )
  );

  /* Harness */
  root.updateMatrixWorld(true);
  const w = new T.Vector3();
  sens.forEach((o, i) => {
    o.getWorldPosition(w);
    const sx = -0.115 + (i % 3) * 0.03;
    tube(
      root,
      [
        [sx, 0.01, -0.2275],
        [sx + (w.x - sx) * 0.3, w.y * 0.4 + 0.005, -0.21],
        [w.x * 0.85, w.y + 0.03, w.z - 0.03],
        [w.x, w.y, w.z],
      ],
      0.0022,
      AeroMats.ecuWiring,
      "Harness_Cable_" + (i + 1),
      20
    );
  });

  /* Animation hook */
  const update = (a: number) => {
    crank.rotation.z = a;
    for (let i = 0; i < C.length; i++) {
      const c = C[i];
      const th = c.th + a,
        px0 = R * Math.cos(th),
        py0 = R * Math.sin(th),
        px = px0 + c.s * Math.sqrt(L * L - py0 * py0);
      pist[i].position.set(px, 0, c.z);
      rods[i].position.set(px0, py0, c.z);
      rods[i].rotation.z = Math.atan2(-py0, px - px0);
    }
    const r = a / 2.43;
    shaft.rotation.z = r;
    prop.rotation.z = r;
    rg2.rotation.z = r;
  };

  update(0);
  bg.y.dispose();
  return { root, update };
}
