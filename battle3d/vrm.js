// VRM avatars (.vrm, VRM 0.x and 1.0) for the 3D battle. See battle3d/CONTRACT.md (v6, section 3).
// @pixiv/three-vrm (MIT, 3.5.5, peer three >= 0.137, imports only 'three') is imported lazily the first time a
// VRM is loaded: through the import map key "@pixiv/three-vrm", else straight from jsDelivr.
//
//   isVrmFile(nameOrUrl)                 -> true for *.vrm
//   sniffVrm(arrayBuffer)                -> true when a GLB declares VRM / VRMC_vrm (blob URLs have no extension)
//   await loadVRM(urlOrArrayBufferOrFile, { GLTFLoader, meshoptDecoder, materials, springBones })
//                                        -> gltf with gltf.userData.vrm and gltf.userData.vrmMeta; pass it to retarget.prepare
//   vrmMeta(gltfOrVrm)                   -> { version, title, authors, license, licenseUrl, avatarPermission, commercial,
//                                             violentUse, redistribution, creditRequired, warnings }
//
// Choices for the battle: VRM 0.x avatars are turned to face +Z like our models (retarget.js also checks facing);
// spring bones (hair, skirts) are off by default because units.js clones each model and clones would not share
// the spring simulation; MToon toon materials become MeshStandardMaterial so avatars are lit like the board and
// the KayKit pieces (pass materials: 'mtoon' to keep them). The humanoid normalized rig is removed: retarget.js
// rebinds the raw bones instead, which survives SkeletonUtils.clone and needs no per-frame update.

import * as THREE from 'three';

export const THREE_VRM_VERSION = '3.5.5';
const CDN = `https://cdn.jsdelivr.net/npm/@pixiv/three-vrm@${THREE_VRM_VERSION}/lib/three-vrm.module.min.js`;

let lib = null;

// Tests (node) inject the package; the browser uses the import map or the CDN.
export function setVrmLibrary(mod) { lib = mod ? Promise.resolve(mod) : null; }

export function loadVrmLibrary() {
    if (!lib) {
        lib = import('@pixiv/three-vrm')
            .catch(() => import(CDN))
            .catch(e => { lib = null; throw new Error(`Could not load the VRM library (offline?): ${e.message || e}`); });
    }
    return lib;
}

export const isVrmFile = nameOrUrl => /\.vrm(?:$|[?#])/i.test(String(nameOrUrl || ''));

// Reads the GLB JSON chunk only (no parsing of meshes).
export function sniffVrm(buffer) {
    try {
        const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (bytes.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) return false;   // 'glTF'
        const len = dv.getUint32(12, true);
        const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len)));
        const used = [...(json.extensionsUsed || []), ...Object.keys(json.extensions || {})];
        return used.includes('VRMC_vrm') || used.includes('VRM');
    } catch (e) { return false; }
}

/**
 * Loads a .vrm file.
 * @param {string|ArrayBuffer|Blob} src URL (blob URLs work), file contents or a File
 * @param {object} o
 * @param {Function} o.GLTFLoader the GLTFLoader class (three/addons/loaders/GLTFLoader.js)
 * @param {object} [o.meshoptDecoder]
 * @param {'standard'|'mtoon'} [o.materials='standard']
 * @param {boolean} [o.springBones=false] keep vrm.springBoneManager usable (caller must call vrm.update(dt) itself)
 */
export async function loadVRM(src, { GLTFLoader, meshoptDecoder = null, materials = 'standard', springBones = false } = {}) {
    if (!GLTFLoader) throw new Error('loadVRM needs the GLTFLoader class');
    const { VRMLoaderPlugin, VRMUtils } = await loadVrmLibrary();
    const loader = new GLTFLoader();
    if (meshoptDecoder && loader.setMeshoptDecoder) loader.setMeshoptDecoder(meshoptDecoder);
    loader.register(parser => new VRMLoaderPlugin(parser, { autoUpdateHumanBones: false }));
    if (src && typeof src !== 'string' && typeof src.arrayBuffer === 'function') src = await src.arrayBuffer();   // File / Blob
    const gltf = typeof src === 'string' ? await loader.loadAsync(src) : await loader.parseAsync(src, '');
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('Not a VRM file (no VRM or VRMC_vrm extension).');

    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.rotateVRM0(vrm);
    vrm.humanoid?.normalizedHumanBonesRoot?.removeFromParent();
    if (!springBones) vrm.springBoneManager?.reset?.();

    // Meshes meant for a first-person camera only (e.g. a headless body) are hidden.
    for (const a of vrm.firstPerson?.meshAnnotations || []) {
        if (a.type === 'firstPersonOnly') for (const p of a.meshes || [a.mesh]) if (p) p.visible = false;
    }
    gltf.scene.traverse(o => {
        if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; }
        if (!springBones) o.matrixAutoUpdate = true;   // three-vrm turns it off on spring joints
    });
    if (materials !== 'mtoon') convertMaterials(gltf.scene);
    gltf.userData.vrmMeta = vrmMeta(vrm);
    return gltf;
}

// MToon -> MeshStandardMaterial; outline passes are dropped; unlit materials become lit.
const hidden = new THREE.MeshBasicMaterial({ visible: false });
export function convertMaterials(root) {
    const done = new Map();
    const conv = m => {
        if (!m) return m;
        if (done.has(m)) return done.get(m);
        let out = m;
        if (m.isMToonMaterial && m.isOutline) out = hidden;
        else if (m.isMToonMaterial || m.isMeshBasicMaterial) {
            out = new THREE.MeshStandardMaterial({
                name: m.name, color: m.color ? m.color.clone() : 0xffffff, map: m.map || null,
                normalMap: m.normalMap || null, emissive: m.emissive ? m.emissive.clone() : 0x000000,
                emissiveMap: m.emissiveMap || null, emissiveIntensity: m.emissiveIntensity ?? 1,
                transparent: m.transparent, opacity: m.opacity ?? 1, alphaTest: m.alphaTest || 0,
                side: m.side, depthWrite: m.depthWrite, roughness: 0.85, metalness: 0
            });
            if (m.normalScale && out.normalScale) out.normalScale.copy(m.normalScale);
            out.vertexColors = !!m.vertexColors && !m.ignoreVertexColor;
            out.userData.vrmSource = m.name;
        }
        done.set(m, out);
        return out;
    };
    root.traverse(o => {
        if (!o.isMesh) return;
        o.material = Array.isArray(o.material) ? o.material.map(conv) : conv(o.material);
    });
}

// License and usage terms from the avatar (VRM files carry them; the cast editor should show them).
export function vrmMeta(gltfOrVrm) {
    const meta = (gltfOrVrm?.userData?.vrm || gltfOrVrm)?.meta;
    if (!meta) return null;
    const warnings = [];
    let out;
    if (meta.metaVersion === '0') {
        out = {
            version: '0', title: meta.title || '', authors: meta.author ? [meta.author] : [],
            license: meta.licenseName || '', licenseUrl: meta.otherLicenseUrl || '',
            avatarPermission: { OnlyAuthor: 'onlyAuthor', ExplicitlyLicensedPerson: 'onlySeparatelyLicensedPerson', Everyone: 'everyone' }[meta.allowedUserName] || meta.allowedUserName || '',
            commercial: meta.commercialUssageName === 'Allow',
            violentUse: meta.violentUssageName === 'Allow',
            redistribution: null, creditRequired: null
        };
    } else {
        out = {
            version: '1', title: meta.name || '', authors: meta.authors || [],
            license: meta.licenseUrl ? 'VRM Public License 1.0' : '', licenseUrl: meta.licenseUrl || meta.otherLicenseUrl || '',
            avatarPermission: meta.avatarPermission || '',
            commercial: meta.commercialUsage ? meta.commercialUsage !== 'personalNonProfit' : null,
            violentUse: !!meta.allowExcessivelyViolentUsage,
            redistribution: meta.allowRedistribution ?? null, creditRequired: meta.creditNotation === 'required'
        };
    }
    if (out.avatarPermission === 'onlyAuthor') warnings.push('The avatar license says only its author may use it.');
    // VRM 1.0 asks only about "excessively" violent use; cartoon chess battles are fine unless 0.x says Disallow.
    if (out.version === '0' && !out.violentUse) warnings.push('The avatar license does not allow violent use; battles show fights and knock-outs.');
    if (out.creditRequired) warnings.push(`Credit required: ${out.authors.join(', ') || 'see the license'}.`);
    out.warnings = warnings;
    return out;
}
