const fs = require('fs');
let html = fs.readFileSync('c:/Projects/Cricket Arbitrage/DecimalArbitrage/decimal-bot.html', 'utf8');

// Add the slider to the HTML
html = html.replace(
    '<button class="am-btn" id="amM2" onclick="setCalcMode(\'m2\')">IF <span id="m2NameBtn">KOL</span> WINS</button>',
    `<button class="am-btn" id="amM2" onclick="setCalcMode('m2')">IF <span id="m2NameBtn">KOL</span> WINS</button>
                    </div>
                    <div style="margin-top:12px; display:flex; align-items:center; gap:10px;">
                        <label style="font-size:12px;color:var(--txt2)">Profit Allocation Slider:</label>
                        <input type="range" id="arbSlider" min="0" max="100" value="50" oninput="onArbSlider(this.value)" style="flex:1" />
                        <span id="arbSliderVal" style="font-size:12px;font-weight:bold;color:var(--g)">50%</span>
                    </div>`
);

// Add global variable and function
html = html.replace(
    'let _polyAutoSwitching = false;',
    `let _polyAutoSwitching = false;
        let _sliderValue = 0.5;

        function onArbSlider(val) {
            _sliderValue = parseFloat(val) / 100;
            document.getElementById('arbSliderVal').innerText = val + '%';
            if (val == 50) {
                setCalcMode('both');
            } else {
                setCalcMode('slider');
            }
        }`
);

// Update setCalcMode
html = html.replace(
    `function setCalcMode(mode) {
            calcMode = mode;
            $('amBoth').classList.toggle('on', mode === 'both');
            $('amM1').classList.toggle('on', mode === 'm1');
            $('amM2').classList.toggle('on', mode === 'm2');
            recalc();
        }`,
    `function setCalcMode(mode) {
            calcMode = mode;
            $('amBoth').classList.toggle('on', mode === 'both' || (mode === 'slider' && _sliderValue === 0.5));
            $('amM1').classList.toggle('on', mode === 'm1');
            $('amM2').classList.toggle('on', mode === 'm2');
            
            if (mode === 'm1') {
                $('arbSlider').value = 100;
                $('arbSliderVal').innerText = '100%';
            } else if (mode === 'm2') {
                $('arbSlider').value = 0;
                $('arbSliderVal').innerText = '0%';
            } else if (mode === 'both') {
                $('arbSlider').value = 50;
                $('arbSliderVal').innerText = '50%';
            }
            recalc();
        }`
);

// Update targetMax calculation
html = html.replace(
    `let targetMax = 'both';
            if (calcMode === 'm1') targetMax = (currArb === 1) ? 'W' : 'L';
            if (calcMode === 'm2') targetMax = (currArb === 1) ? 'L' : 'W';`,
    `let targetMax = 'both';
            if (calcMode === 'm1') targetMax = (currArb === 1) ? 'W' : 'L';
            if (calcMode === 'm2') targetMax = (currArb === 1) ? 'L' : 'W';
            if (calcMode === 'slider') targetMax = _sliderValue;`
);

// Update calcArbRows to handle numbers
html = html.replace(
    `} else if (mode === 'L') {
                poly_inr = bs / (effectivePolyOdds - 1);
            } else {
                poly_inr = (w * b) / effectivePolyOdds;
            }`,
    `} else if (mode === 'L') {
                poly_inr = bs / (effectivePolyOdds - 1);
            } else if (mode === 'both') {
                poly_inr = (w * b) / effectivePolyOdds;
            } else if (typeof mode === 'number') {
                const min_poly = bs / (effectivePolyOdds - 1);
                const max_poly = w;
                poly_inr = min_poly + mode * (max_poly - min_poly);
            }`
);

fs.writeFileSync('c:/Projects/Cricket Arbitrage/DecimalArbitrage/decimal-bot.html', html);
console.log('Slider added successfully');
