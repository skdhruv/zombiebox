/*
 * This file is part of the ZombieBox package.
 *
 * Copyright (c) 2012-2019, Interfaced
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
const path = require('path');
const fs = require('fs');
const fse = require('fs-extra');

const SourceProviderBase = require('./source-provider-base');
const ISourceProvider = require('./i-source-provider');
const AbstractExtension = require('../addons/abstract-extension');


/**
 * @implements {ISourceProvider}
 */
class SourceProviderCodeCache extends SourceProviderBase {
	/**
	 * @param {CodeSource} codeSource
	 * @param {AddonLoader} addonLoader
	 * @param {PathHelper} pathHelper
	 * @param {TemplateHelper} templateHelper
	 * @param {IZombieBoxConfig} buildConfig
	 * @param {Object} packageJson
	 */
	constructor(codeSource, addonLoader, pathHelper, templateHelper, buildConfig, packageJson) {
		super();

		/**
		 * @type {PathHelper}
		 * @protected
		 */
		this._pathHelper = pathHelper;

		/**
		 * @type {string}
		 * @protected
		 */
		this._root = pathHelper.resolveAbsolutePath(buildConfig.generatedCode);

		/**
		 * @type {TemplateHelper}
		 * @private
		 */
		this._templateHelper = templateHelper;

		/**
		 * @type {IZombieBoxConfig}
		 * @private
		 */
		this._buildConfig = buildConfig;

		/**
		 * @type {Object}
		 * @private
		 */
		this._packageJson = packageJson;

		/**
		 * @type {AddonLoader}
		 * @private
		 */
		this._addonLoader = addonLoader;

		this._setupExtensions(codeSource);

		const fsReadyPromises = Array.from(codeSource.aliasedSources)
			.map(([, fsSource]) => fsSource.ready());

		this._readyPromise = Promise.all(fsReadyPromises);
	}

	/**
	 */
	clean() {
		if (!fse.pathExistsSync(this._root)) {
			return;
		}

		const files = fs.readdirSync(this._root);
		files.forEach((filename) => {
			if (filename.charAt(0) === '.') {
				// Skip hidden files
				return;
			}
			const src = path.join(this._root, filename);
			if (fs.statSync(src)
				.isFile()) {
				fs.unlinkSync(src);
			} else {
				fse.removeSync(src);
			}
		});

		this._files = [];
	}

	/**
	 * Clean and build code.
	 */
	buildCode() {
		this.clean();
		this.generateBaseApp();
		this.generateExtensionsCode();
		this.generateDefines();
	}

	/**
	 */
	generateBaseApp() {
		const platformNames = this._addonLoader.getPlatforms()
			.map((platform) => platform.getName());

		// PC is a special platform that can't be detected properly and should be the last in the list
		if (platformNames.includes('pc')) {
			platformNames.splice(platformNames.findIndex((name) => name === 'pc'), 1);
			platformNames.push('pc');
		}

		this._writeFile(
			'base-application.js',
			this._templateHelper.render('base-application.js.tpl', {
				platforms: platformNames
			})
		);

		const mainPath = path.join(
			this._buildConfig.project.name,
			path.relative(
				this._pathHelper.resolveAbsolutePath(this._buildConfig.project.src),
				this._pathHelper.resolveAbsolutePath(this._buildConfig.project.entry)
			)
		);

		this._writeFile(
			'app.js',
			this._templateHelper.render('app.js.tpl', {
				path: mainPath.replace(/\.js$/, '')
			})
		);

		// TODO: filter out unnecessary fields or whitelist them
		this._writeFile(
			'package-info.js',
			this._templateHelper.render('package-info.js.tpl', {
				config: this._packageJson
			})
		);
	}

	/**
	 */
	generateExtensionsCode() {
		this._addonLoader.getExtensions()
			.forEach((extension) => {
				const sources = this._resolveAddonRelativeSources(extension, extension.generateCode(this._buildConfig));
				this._writeSources(sources);
			});
	}

	/**
	 */
	generateDefines() {
		/**
		 * @param {Array<*>} array
		 * @return {string}
		 */
		const getArrayContentsType = (array) => {
			if (!array.length) {
				return '*';
			}

			const elementTypes = array.map((element) => getGCCType(element));
			return Array.from(new Set(elementTypes))
				.join('|');
		};

		/**
		 * @param {*} value
		 * @return {string}
		 */
		const getGCCType = (value) => {
			const jsType = typeof value;

			if (jsType === 'function') {
				return 'Function';
			}

			if (jsType !== 'object') {
				return jsType;
			}

			if (value === null) {
				return 'null';
			}

			if (Array.isArray(value)) {
				return `Array<${getArrayContentsType(value)}>`;
			}

			return 'Object';
		};

		/**
		 * @param {string} type
		 * @return {string}
		 */
		const printTypeTag = (type) => type === 'Object' ?
			'@struct' :
			`@const {${type}}`;

		/**
		 * @param {...string} tags
		 * @return {string}
		 */
		const printJsdoc = (...tags) => [
			'/**',
			...tags.map((tag) => ` * ${tag}`),
			' */',
			''
		].join('\n');

		/**
		 * @param {string} string
		 * @return {string}
		 */
		const indent = (string) => '\t' + string.split('\n')
			.join('\n\t');

		/**
		 * @param {Object} object
		 * @return {string}
		 */
		const printObject = (object) => [
			'{',
			indent(
				Object.keys(object)
					.map((key) => {
						const value = object[key];
						const type = getGCCType(value);

						return printJsdoc(printTypeTag(type)) +
							`${key}: ${printValue(type, value)}`;
					})
					.join(',\n\n')
			),
			'}'
		].join('\n');

		/**
		 * @param {string} type
		 * @param {*} value
		 * @return {string}
		 */
		const printValue = (type, value) => {
			switch (type) {
				case 'Object':
					return printObject(value);
				case 'number':
				case 'Function':
					return value.toString();
				default:
					return JSON.stringify(value);
			}
		};

		const content = Object.keys(this._buildConfig.define)
			.map((topLevelKey) => {
				const value = this._buildConfig.define[topLevelKey];
				const type = getGCCType(value);

				return printJsdoc(printTypeTag(type)) +
					`export const ${topLevelKey} = ${printValue(type, value)};`;
			})
			.join('\n\n');

		this._writeFile('define.js', content);
	}

	/**
	 * @param {CodeSource} codeSource
	 * @private
	 */
	_setupExtensions(codeSource) {
		this._addonLoader.getExtensions().forEach((extension) => {
			extension.on(AbstractExtension.EVENT_GENERATED, (sources) => {
				this._writeSources(this._resolveAddonRelativeSources(extension, sources));
			});

			extension.setCodeSource(codeSource);
		});
	}

	/**
	 * @param {AbstractExtension} addon
	 * @param {Object<string, string>} sources
	 * @return {Object<string, string>}
	 * @private
	 */
	_resolveAddonRelativeSources(addon, sources) {
		const filePaths = Object.keys(sources);
		return filePaths.reduce((result, filePath) => {
			const addonRelativePath = path.join(addon.getName(), filePath);
			return Object.assign(result, {[addonRelativePath]: sources[filePath]});
		}, {});
	}

	/**
	 * @param {Object<string, string>} sources
	 * @private
	 */
	_writeSources(sources) {
		Object.keys(sources)
			.forEach((src) => {
				this._writeFile(src, sources[src]);
			});
	}

	/**
	 * @param {string} src
	 * @param {string} content
	 * @private
	 */
	_writeFile(src, content) {
		const filename = path.join(this._root, src);

		const dir = path.dirname(filename);
		if (!fs.existsSync(dir)) {
			fse.ensureDirSync(dir);
		}

		fs.writeFileSync(filename, content, 'utf-8');
		if (!this._files.includes(filename)) {
			this._files.push(filename);
		}

		this.emit(ISourceProvider.EVENT_CHANGED, filename);
		this.emit(ISourceProvider.EVENT_ANY, ISourceProvider.EVENT_CHANGED, filename);
	}
}


module.exports = SourceProviderCodeCache;