"use strict";
document.getElementById('moregame').href = "https://gamebox.heheda." + (window.location.hostname.includes('heheda.cn') ?
	'cn' : 'top');
document.getElementById('fullscreenBtn').onclick = () => {
	if (!document.fullscreenElement) {
		document.documentElement.requestFullscreen();
	} else {
		if (document.exitFullscreen) document.exitFullscreen();
	}
}
let preloadedFiles = {};
const OrigXHR = window.XMLHttpRequest;
window.XMLHttpRequest = class CustomXHR {
	constructor() {
		this.xhr = new OrigXHR();
		this.listeners = {};
		this._responseType = '';
		this.isMocked = false;
		this.mockData = null;
		this.readyState = 0;
		this.status = 0;
		const events = ['readystatechange', 'load', 'error', 'progress', 'loadstart', 'loadend'];
		events.forEach(e => {
			this.xhr.addEventListener(e, (ev) => {
				if (!this.isMocked) {
					this.readyState = this.xhr.readyState;
					this.status = this.xhr.status;
					this.dispatchEvent(new Event(e));
					if (this[`on${e}`]) this[`on${e}`](ev);
				}
			});
		});
	}
	open(method, url) {
		const urlStr = url.toString();
		// 拦截 Unity 统计上报请求，直接 mock 成功，避免报错
		if (urlStr.includes('unity3d.com/v1/events')) {
			this.isMocked = true;
			this.mockData = new Uint8Array();
			this.readyState = 1;
			return;
		}
		let name = urlStr.split('/').pop();
		if (preloadedFiles[name]) {
			this.isMocked = true;
			this.mockData = preloadedFiles[name];
			this.readyState = 1;
		} else {
			this.xhr.open(method, url);
		}
	}
	send(body) {
		if (this.isMocked) {
			setTimeout(() => {
				this.readyState = 4;
				this.status = 200;
				let pr = new Event('progress');
				pr.lengthComputable = true;
				pr.loaded = this.mockData.byteLength;
				pr.total = this.mockData.byteLength;
				this.dispatchEvent(pr);
				if (this.onprogress) this.onprogress(pr);
				let ev = new Event('readystatechange');
				this.dispatchEvent(ev);
				if (this.onreadystatechange) this.onreadystatechange(ev);
				let ld = new Event('load');
				this.dispatchEvent(ld);
				if (this.onload) this.onload(ld);
			}, 0);
		} else {
			this.xhr.send(body);
		}
	}
	get responseType() {
		return this.isMocked ? this._responseType : this.xhr.responseType;
	}
	set responseType(val) {
		this._responseType = val;
		if (!this.isMocked) this.xhr.responseType = val;
	}
	get response() {
		if (this.isMocked) {
			if (this._responseType === 'arraybuffer') return this.mockData.buffer.slice(this.mockData
				.byteOffset, this.mockData.byteOffset + this
				.mockData.byteLength);
			if (this._responseType === 'json') return JSON.parse(new TextDecoder().decode(this.mockData));
			return new TextDecoder().decode(this.mockData);
		}
		return this.xhr.response;
	}
	get responseText() {
		if (this.isMocked) {
			if (this._responseType === '' || this._responseType === 'text') return new TextDecoder().decode(this
				.mockData);
			return "";
		}
		if (this.xhr.responseType === '' || this.xhr.responseType === 'text') return this.xhr.responseText;
		return "";
	}
	get statusText() {
		return this.isMocked ? "OK" : this.xhr.statusText;
	}
	get responseURL() {
		return this.isMocked ? "" : this.xhr.responseURL;
	}
	addEventListener(type, listener) {
		if (!this.listeners[type]) this.listeners[type] = [];
		this.listeners[type].push(listener);
	}
	removeEventListener(type, listener) {
		if (this.listeners[type]) this.listeners[type] = this.listeners[type].filter(l => l !== listener);
	}
	dispatchEvent(event) {
		if (this.listeners[event.type]) this.listeners[event.type].forEach(l => l(event));
	}
	setRequestHeader(k, v) {
		if (!this.isMocked) this.xhr.setRequestHeader(k, v);
	}
	getResponseHeader(k) {
		return this.isMocked ? null : this.xhr.getResponseHeader(k);
	}
	getAllResponseHeaders() {
		return this.isMocked ? "" : this.xhr.getAllResponseHeaders();
	}
	abort() {
		if (!this.isMocked) this.xhr.abort();
	}
	overrideMimeType(m) {
		if (!this.isMocked) this.xhr.overrideMimeType(m);
	}
	get withCredentials() {
		return this.isMocked ? false : this.xhr.withCredentials;
	}
	set withCredentials(v) {
		if (!this.isMocked) this.xhr.withCredentials = v;
	}
};

document.getElementById('playbut').onclick = async () => {
	document.getElementById('butdiv').style.display = 'none';
	document.getElementById('textdiv').style.display = 'block';
	// 开启全屏
	if (!document.fullscreenElement) document.documentElement.requestFullscreen();
	// 封装错误处理函数
	const loadText = document.getElementById('loadingText'),
		handleError = (err) => {
			console.error('❌ ' + err);
			loadText.textContent = `错误: ${err}`;
		},
		// 封装Worker终止逻辑
		terminateWorker = () => {
			if (worker) {
				worker.terminate();
				console.log('✅ worker 关闭成功')
			}
		},
		worker = new Worker('./script/worker.js');
	// 监听Worker消息
	worker.onmessage = (msg) => {
		const {
			type,
			data,
			error
		} = msg.data;
		switch (type) {
			case 'status':
				loadText.textContent = data;
				break;
			case 'error':
				handleError(`Worker返回错误: ${error}`);
				break;
			case 'complete':
				if (!data.dataBuffer || !data.codeBuffer || !data.frameworkBuffer || !data.jsonBuffer || !
					data.jsBuffer || !data.GMDBuffer || !data.VIBuffer || !data.LTBuffer || !data
					.LOBuffer || !
					data.CFBuffer || !data.ACBuffer || !data.BLESBuffer)
					throw new Error(
						'❌ 数据缺失！');
				preloadedFiles['angry.json'] = new Uint8Array(data.jsonBuffer);
				preloadedFiles['angry.data.unityweb'] = new Uint8Array(data.dataBuffer);
				preloadedFiles['angry.wasm.code.unityweb'] = new Uint8Array(data.codeBuffer);
				preloadedFiles['angry.wasm.framework.unityweb'] = new Uint8Array(data.frameworkBuffer);
				preloadedFiles['GameMasterData.json'] = new Uint8Array(data.GMDBuffer);
				preloadedFiles['VersionInformation.txt'] = new Uint8Array(data.VIBuffer);
				preloadedFiles['LoadingTips.txt'] = new Uint8Array(data.LTBuffer);
				preloadedFiles['LevelOverrides.txt'] = new Uint8Array(data.LOBuffer);
				preloadedFiles['CrashFilters.txt'] = new Uint8Array(data.CFBuffer);
				preloadedFiles['ArenaConfiguration.txt'] = new Uint8Array(data.ACBuffer);
				preloadedFiles['BrandedLevelEventSchedule.json'] = new Uint8Array(data.BLESBuffer);
				const script = document.createElement('script');
				script.defer = true;
				script.type = 'text/javascript';
				script.src = URL.createObjectURL(new Blob([data.jsBuffer], {
					type: 'application/javascript; charset=utf-8'
				}));
				script.onload = () => {
					window.unityInstance = UnityLoader.instantiate("unityContainer", 'angry.json');
				};
				document.body.appendChild(script);
				break;
		}
	}
	// 监听Worker错误
	worker.onerror = (err) => {
		handleError(`Worker错误: ${err.message} (行${err.lineno})`);
		terminateWorker();
	}
	// 监听Worker消息错误
	worker.onmessageerror = (err) => {
		handleError(`Worker消息错误: ${err.message}`);
		terminateWorker();
	}
	// 页面关闭时终止worker
	window.addEventListener("beforeunload", (event) => {
		event.preventDefault();
		terminateWorker();
	});
};