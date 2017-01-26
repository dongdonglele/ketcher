var Set = require('../../util/set');
var Vec2 = require('../../util/vec2');

var Struct = require('./../struct/index');
var utils = require('./utils');

function readKeyValuePairs(str, /* bool */ valueString) {
	/* reader */
	var ret = {};
	var partition = utils.partitionLineFixed(str, 3, true);
	var count = utils.parseDecimalInt(partition[0]);
	for (var i = 0; i < count; ++i) {
		/* eslint-disable no-mixed-operators*/
		ret[utils.parseDecimalInt(partition[2 * i + 1]) - 1] =
			valueString ? partition[2 * i + 2].strip() :
				utils.parseDecimalInt(partition[2 * i + 2]);
		/* eslint-enable no-mixed-operators*/
	}
	return ret;
}

function readKeyMultiValuePairs(str, /* bool */ valueString) {
	/* reader */
	var ret = [];
	var partition = utils.partitionLineFixed(str, 3, true);
	var count = utils.parseDecimalInt(partition[0]);
	for (var i = 0; i < count; ++i) {
		ret.push([
			/* eslint-disable no-mixed-operators*/
			utils.parseDecimalInt(partition[2 * i + 1]) - 1,
			valueString ? partition[2 * i + 2].strip() : utils.parseDecimalInt(partition[2 * i + 2])
			/* eslint-enable no-mixed-operators*/
		]);
	}
	return ret;
}

function postLoadMul(sgroup, mol, atomMap) { // eslint-disable-line max-statements
	sgroup.data.mul = sgroup.data.subscript - 0;
	var atomReductionMap = {};

	sgroup.atoms = Struct.SGroup.filterAtoms(sgroup.atoms, atomMap);
	sgroup.patoms = Struct.SGroup.filterAtoms(sgroup.patoms, atomMap);

	// mark repetitions for removal
	for (var k = 1; k < sgroup.data.mul; ++k) {
		for (var m = 0; m < sgroup.patoms.length; ++m) {
			var raid = sgroup.atoms[k * sgroup.patoms.length + m]; // eslint-disable-line no-mixed-operators
			if (raid < 0)
				continue; // eslint-disable-line no-continue
			if (sgroup.patoms[m] < 0)
				throw new Error('parent atom missing');
			//                mol.atoms.get(raid).pp.y -= 3*k; // for debugging purposes
			atomReductionMap[raid] = sgroup.patoms[m]; // "merge" atom in parent
		}
	}
	sgroup.patoms = Struct.SGroup.removeNegative(sgroup.patoms);

	var patomsMap = identityMap(sgroup.patoms);

	var bondsToRemove = [];
	mol.bonds.each(function (bid, bond) {
		var beginIn = bond.begin in atomReductionMap;
		var endIn = bond.end in atomReductionMap;
		// if both adjacent atoms of a bond are to be merged, remove it
		/* eslint-disable no-mixed-operators*/
		if (beginIn && endIn ||
			beginIn && bond.end in patomsMap ||
			endIn && bond.begin in patomsMap)
			bondsToRemove.push(bid);
		/* eslint-enable no-mixed-operators*/
		// if just one atom is merged, modify the bond accordingly
		else if (beginIn)
			bond.begin = atomReductionMap[bond.begin];
		else if (endIn)
			bond.end = atomReductionMap[bond.end];
	}, sgroup);

	// apply removal lists
	for (var b = 0; b < bondsToRemove.length; ++b)
		mol.bonds.remove(bondsToRemove[b]);
	for (var a in atomReductionMap) {
		mol.atoms.remove(a);
		atomMap[a] = -1;
	}
	sgroup.atoms = sgroup.patoms;
	sgroup.patoms = null;
}

function postLoadSru(sgroup) {
	sgroup.data.connectivity = (sgroup.data.connectivity || 'EU').strip().toLowerCase();
}

function postLoadSup(sgroup) {
	sgroup.data.name = (sgroup.data.subscript || '').strip();
	sgroup.data.subscript = '';
}

function postLoadGen(sgroup, mol, atomMap) { // eslint-disable-line no-unused-vars
}

function postLoadDat(sgroup, mol) {
	if (!sgroup.data.absolute)
		sgroup.pp = sgroup.pp.add(Struct.SGroup.getMassCentre(mol, sgroup.atoms));
	// [NK] Temporary comment incoplete 'allAtoms' behavior
	// TODO: need ether remove 'allAtoms' flag or hadle it
	// consistently (other flags: *_KEY, *_RADICAL?)
	// var allAtomsInGroup = this.atoms.length == mol.atoms.count();
	// if (allAtomsInGroup &&
	//     (this.data.fieldName == 'MDLBG_FRAGMENT_STEREO' ||
	//      this.data.fieldName == 'MDLBG_FRAGMENT_COEFFICIENT' ||
	//      this.data.fieldName == 'MDLBG_FRAGMENT_CHARGE')) {
	// 	this.atoms = [];
	// 	this.allAtoms = true;
	// }
}

function loadSGroup(mol, sg, atomMap) {
	var postLoadMap = {
		MUL: postLoadMul,
		SRU: postLoadSru,
		SUP: postLoadSup,
		DAT: postLoadDat,
		GEN: postLoadGen
	};

	// add the group to the molecule
	sg.id = mol.sgroups.add(sg);

	// apply type-specific post-processing
	postLoadMap[sg.type](sg, mol, atomMap);
	// mark atoms in the group as belonging to it
	for (var s = 0; s < sg.atoms.length; ++s) {
		if (mol.atoms.has(sg.atoms[s]))
			Set.add(mol.atoms.get(sg.atoms[s]).sgs, sg.id);
	}

	if (sg.type == 'DAT')
		mol.sGroupForest.insert(sg.id, -1, []);
	else
		mol.sGroupForest.insert(sg.id);

	return sg.id;
}

function initSGroup(sGroups, propData) {
	/* reader */
	var kv = readKeyValuePairs(propData, true);
	for (var key in kv) {
		var type = kv[key];
		if (!(type in Struct.SGroup.TYPES))
			throw new Error('Unsupported S-group type');
		var sg = new Struct.SGroup(type);
		sg.number = key;
		sGroups[key] = sg;
	}
}

function applySGroupProp(sGroups, propName, propData, numeric, core) { // eslint-disable-line max-params
	var kv = readKeyValuePairs(propData, !(numeric));
	for (var key in kv)
		// "core" properties are stored directly in an sgroup, not in sgroup.data
		(core ? sGroups[key] : sGroups[key].data)[propName] = kv[key];
}

function applySGroupArrayProp(sGroups, propName, propData, shift) {
	/* reader */
	var sid = utils.parseDecimalInt(propData.slice(1, 4)) - 1;
	var num = utils.parseDecimalInt(propData.slice(4, 8));
	var part = toIntArray(utils.partitionLineFixed(propData.slice(8), 3, true));

	if (part.length != num)
		throw new Error('File format invalid');
	if (shift) {
		part = part.map(function (v) {
			return v + shift;
		});
	}
	sGroups[sid][propName] = sGroups[sid][propName].concat(part);
}

function applyDataSGroupName(sg, name) {
	/* reader */
	sg.data.fieldName = name;
}

function applyDataSGroupQuery(sg, query) {
	/* reader */
	sg.data.query = query;
}

function applyDataSGroupQueryOp(sg, queryOp) {
	/* reader */
	sg.data.queryOp = queryOp;
}

function applyDataSGroupDesc(sGroups, propData) {
	/* reader */
	var split = utils.partitionLine(propData, [4, 31, 2, 20, 2, 3], false);
	var id = utils.parseDecimalInt(split[0]) - 1;
	var fieldName = split[1].strip();
	var fieldType = split[2].strip();
	var units = split[3].strip();
	var query = split[4].strip();
	var queryOp = split[5].strip();
	var sGroup = sGroups[id];
	sGroup.data.fieldType = fieldType;
	sGroup.data.fieldName = fieldName;
	sGroup.data.units = units;
	sGroup.data.query = query;
	sGroup.data.queryOp = queryOp;
}

function applyDataSGroupInfo(sg, propData) { // eslint-disable-line max-statements
	/* reader */
	var split = utils.partitionLine(propData, [10/* x.x*/, 10/* y.y*/, 4/* eee*/, 1/* f*/, 1/* g*/, 1/* h*/, 3/* i */, 3/* jjj*/, 3/* kkk*/, 3/* ll*/, 2/* m*/, 3/* n*/, 2/* oo*/], false);

	var x = parseFloat(split[0]);
	var y = parseFloat(split[1]);
	var attached = split[3].strip() == 'A';
	var absolute = split[4].strip() == 'A';
	var showUnits = split[5].strip() == 'U';
	var nCharsToDisplay = split[7].strip();
	nCharsToDisplay = nCharsToDisplay == 'ALL' ? -1 : utils.parseDecimalInt(nCharsToDisplay);
	var tagChar = split[10].strip();
	var daspPos = utils.parseDecimalInt(split[11].strip());

	sg.pp = new Vec2(x, -y);
	sg.data.attached = attached;
	sg.data.absolute = absolute;
	sg.data.showUnits = showUnits;
	sg.data.nCharsToDisplay = nCharsToDisplay;
	sg.data.tagChar = tagChar;
	sg.data.daspPos = daspPos;
}

function applyDataSGroupInfoLine(sGroups, propData) {
	/* reader */
	var id = utils.parseDecimalInt(propData.substr(0, 4)) - 1;
	var sg = sGroups[id];
	applyDataSGroupInfo(sg, propData.substr(5));
}

function applyDataSGroupData(sg, data, finalize) {
	/* reader */
	sg.data.fieldValue = (sg.data.fieldValue || '') + data;
	if (finalize) {
		sg.data.fieldValue = sg.data.fieldValue.trimRight();
		if (sg.data.fieldValue.startsWith('"') && sg.data.fieldValue.endsWith('"'))
			sg.data.fieldValue = sg.data.fieldValue.substr(1, sg.data.fieldValue.length - 2);
		// Partially revert f556e8, from KETCHER-457 and RB with love
		// sg.data.fieldValue += '\n';
	}
}

function applyDataSGroupDataLine(sGroups, propData, finalize) {
	/* reader */
	var id = utils.parseDecimalInt(propData.substr(0, 5)) - 1;
	var data = propData.substr(5);
	var sg = sGroups[id];
	applyDataSGroupData(sg, data, finalize);
}

// Utilities functions
function toIntArray(strArray) {
	/* reader */
	var ret = [];
	for (var j = 0; j < strArray.length; ++j)
		ret[j] = utils.parseDecimalInt(strArray[j]);
	return ret;
}

function identityMap(array) {
	var map = {};
	for (var i = 0; i < array.length; ++i)
		map[array[i]] = array[i];
	return map;
}

module.exports = {
	readKeyValuePairs: readKeyValuePairs,
	readKeyMultiValuePairs: readKeyMultiValuePairs,
	loadSGroup: loadSGroup,
	initSGroup: initSGroup,
	applySGroupProp: applySGroupProp,
	applySGroupArrayProp: applySGroupArrayProp,
	applyDataSGroupName: applyDataSGroupName,
	applyDataSGroupQuery: applyDataSGroupQuery,
	applyDataSGroupQueryOp: applyDataSGroupQueryOp,
	applyDataSGroupDesc: applyDataSGroupDesc,
	applyDataSGroupInfo: applyDataSGroupInfo,
	applyDataSGroupData: applyDataSGroupData,
	applyDataSGroupInfoLine: applyDataSGroupInfoLine,
	applyDataSGroupDataLine: applyDataSGroupDataLine
};
