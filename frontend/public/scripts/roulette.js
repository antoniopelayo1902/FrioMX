import {Wheel} from 'https://cdn.jsdelivr.net/npm/spin-wheel@4.3.0/dist/spin-wheel-esm.js';

const props = {
    items: [
      {label: '0', backgroundColor:'#008000',labelColor : '#fff', color : 'Verde'},
      {label: '32',backgroundColor : '#f00', labelColor : '#000', color : 'Rojo'  , paridad : 'par', docena : '3'},
      {label: '15', backgroundColor : '#000',labelColor : '#fff', color : 'Negro' , paridad:'impar', docena : '2'},
      {label: '19',backgroundColor : '#f00', labelColor : '#000', color : 'Rojo'  , paridad:'impar', docena : '2'},
      {label: '4', backgroundColor : '#000', labelColor : '#fff', color : 'Negro' , paridad : 'par', docena : '1'},
      {label: '21',backgroundColor : '#f00', labelColor : '#000', color : 'Rojo'  , paridad:'impar', docena : '2'},
      {label: '2', backgroundColor : '#000', labelColor : '#fff', color : 'Negro' , paridad : 'par', docena : '1'},
      {label: '25',backgroundColor : '#f00', labelColor : '#000', color : 'Rojo'  , paridad:'impar', docena : '3'},
      {label: '17', backgroundColor : '#000',labelColor : '#fff', color : 'Negro' , paridad:'impar', docena : '2'},
      {label: '34',backgroundColor : '#f00', labelColor : '#000', color : 'Rojo'  , paridad : 'par', docena : '3'},
      {label: '6', backgroundColor : '#000', labelColor : '#fff', color : 'Negro' , paridad : 'par', docena : '1'},
      {label: '27',backgroundColor : '#f00', labelColor : '#000', color : 'Rojo'  , paridad:'impar', docena : '3'},
      {label: '13', backgroundColor : '#000',labelColor : '#fff', color : 'Negro' , paridad:'impar', docena : '2'},
      {label: '36',backgroundColor : '#f00', labelColor : '#000', color : 'Rojo'  , paridad : 'par', docena : '3'},
      {label: '11', backgroundColor : '#000',labelColor : '#fff', color : 'Negro' , paridad:'impar', docena : '1'},
      {label: '30',backgroundColor : '#f00', labelColor : '#000', color : 'Rojo'  , paridad : 'par', docena : '3'},
      {label: '8', backgroundColor : '#000', labelColor : '#fff', color : 'Negro' , paridad : 'par', docena : '1'},
      {label: '23',backgroundColor : '#f00', labelColor : '#000', color : 'Rojo'  , paridad:'impar', docena : '2'},
      {label: '10', backgroundColor : '#000',labelColor : '#fff', color : 'Negro' , paridad : 'par', docena : '1'},
      {label: '5',backgroundColor : '#f00',  labelColor : '#000', color : 'Rojo'  , paridad:'impar', docena : '1'},
      {label: '24', backgroundColor : '#000',labelColor : '#fff', color : 'Negro' , paridad : 'par', docena : '2'},
      {label: '16',backgroundColor : '#f00', labelColor : '#000', color : 'Rojo'  , paridad : 'par', docena : '2'},
      {label: '33', backgroundColor : '#000',labelColor : '#fff', color : 'Negro' , paridad:'impar', docena : '3'},
      {label: '1', backgroundColor : '#f00', labelColor : '#000', color : 'Rojo'  , paridad:'impar', docena : '1'},
      {label: '20', backgroundColor : '#000',labelColor : '#fff', color : 'Negro' , paridad : 'par', docena : '2'},
      {label: '14',backgroundColor : '#f00', labelColor : '#000', color : 'Rojo'  , paridad : 'par', docena : '2'},
      {label: '31', backgroundColor : '#000',labelColor : '#fff', color : 'Negro' , paridad:'impar', docena : '3'},
      {label: '9',backgroundColor : '#f00',  labelColor : '#000', color : 'Rojo'  , paridad:'impar', docena : '1'},
      {label: '22', backgroundColor : '#000',labelColor : '#fff', color : 'Negro' , paridad : 'par', docena : '2'},
      {label: '18',backgroundColor : '#f00', labelColor : '#000', color : 'Rojo'  , paridad : 'par', docena : '2'},
      {label: '29', backgroundColor : '#000',labelColor : '#fff', color : 'Negro' , paridad:'impar', docena : '3'},
      {label: '7',backgroundColor : '#f00',  labelColor : '#000', color : 'Rojo'  , paridad:'impar', docena : '1'},
      {label: '28', backgroundColor : '#000',labelColor : '#fff', color : 'Negro' , paridad : 'par', docena : '3'},
      {label: '12',backgroundColor : '#f00', labelColor : '#000', color : 'Rojo'  , paridad : 'par', docena : '1'},
      {label: '35', backgroundColor : '#000',labelColor : '#fff', color : 'Negro' , paridad:'impar', docena : '3'},
      {label: '3',backgroundColor : '#f00',  labelColor : '#000', color : 'Rojo'  , paridad:'impar', docena : '1'},
      {label: '26', backgroundColor : '#000',labelColor : '#fff', color : 'Negro' , paridad : 'par', docena : '3'},
    ]
}

props.itemLabelFontSizeMax = 15;
const container = document.querySelector('.wheel-container');

let btnSpin = document.getElementById('btnSpin');
let checkboxRojo = document.getElementById('checkboxRojo');
let checkboxNegro = document.getElementById('checkboxNegro');
let checkboxVerde = document.getElementById('checkboxVerde');
let cantidadAColor = document.getElementById('cantidadAColor');
let checkboxPar = document.getElementById('checkboxPar');
let checkboxImpar = document.getElementById('checkboxImpar');
let cantidadAParidad = document.getElementById('cantidadAParidad');
let checkboxPrimera = document.getElementById('checkboxPrimera');
let checkboxSegunda = document.getElementById('checkboxSegunda');
let checkboxTercera = document.getElementById('checkboxTercera');
let cantidadADocena = document.getElementById('cantidadADocena');
const ColorDivCantidad = document.getElementById('ColorDivCantidad');
const ParImparDivCantidad = document.getElementById('ParImparDivCantidad');
const decDivCantidad = document.getElementById('decDivCantidad');

let tagBalance = document.getElementById('tagBalance');
let balance = 0;
let balanceActual = 0;

document.addEventListener('DOMContentLoaded', () => {
    loadBalanceRoulette();
});

function loadBalanceRoulette() {
    const xhr = new XMLHttpRequest();
    var token = localStorage.getItem('token');
    var url = getApiUrl(API_CONFIG.ENDPOINTS.BALANCE);

    xhr.open('GET', url, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    
    xhr.onload = function() {
        if (xhr.status !== 200) {
            alert(xhr.status + ': ' + xhr.statusText);
        } else {
            if (xhr.status === 200) {
                let data = JSON.parse(xhr.responseText);
                balanceActual = data.balance;
                tagBalance.innerHTML = data.balance;
            }
        }
    };
    xhr.send();
}

function showHasWon() {
    document.getElementById('hasWon').style.display = 'flex';
    setTimeout(function () {
        document.getElementById('hasWon').style.display = 'none';
    }, 2000);
}

function showHasLost() {
    document.getElementById('hasLost').style.display = 'flex';
    setTimeout(function () {
        document.getElementById('hasLost').style.display = 'none';
    }, 2000);
}

const wheel = new Wheel(container, props);

function init() {
    wheel.borderWidth = 12;
    wheel.isInteractive = false;
    wheel.lineColor = '#D4AF37';
    wheel.radius = 0.9;

    ColorDivCantidad.style.display = "none";
    ParImparDivCantidad.style.display = "none";
    decDivCantidad.style.display = "none";
}

function actualizarVisibilidad() {
    if (checkboxRojo.checked || checkboxNegro.checked || checkboxVerde.checked) {
        ColorDivCantidad.style.display = "block";
    } else {
        ColorDivCantidad.style.display = "none";
    }
}

checkboxRojo.addEventListener('click', () => {
    if (checkboxRojo.checked) {
        checkboxNegro.checked = false;
        checkboxVerde.checked = false;
    }
    if (!checkboxRojo.checked) {
        cantidadAColor.value = "";
    }
    actualizarVisibilidad();
});

checkboxNegro.addEventListener('click', () => {
    if (checkboxNegro.checked) {
        checkboxRojo.checked = false;
        checkboxVerde.checked = false;
    }
    if (!checkboxNegro.checked) {
        cantidadAColor.value = "";
    }
    actualizarVisibilidad();
});

checkboxVerde.addEventListener('click', () => {
    if (checkboxVerde.checked) {
        checkboxRojo.checked = false;
        checkboxNegro.checked = false;
    }
    if (!checkboxVerde.checked) {
        cantidadAColor.value = "";
    }
    actualizarVisibilidad();
});

function actualizarVisibilidadParidad() {
    if (checkboxImpar.checked || checkboxPar.checked) {
        ParImparDivCantidad.style.display = "block";
    } else {
        cantidadAParidad.value = "";
        ParImparDivCantidad.style.display = "none";
    }
}

checkboxImpar.addEventListener('click', () => {
    if (checkboxImpar.checked) {
        checkboxPar.checked = false;
    }
    if (!checkboxImpar.checked && !checkboxPar.checked) {
        cantidadAParidad.value = "";
    }
    actualizarVisibilidadParidad();
});

checkboxPar.addEventListener('click', () => {
    if (checkboxPar.checked) {
        checkboxImpar.checked = false;
    }
    if (!checkboxPar.checked && !checkboxImpar.checked) {
        cantidadAParidad.value = "";
    }
    actualizarVisibilidadParidad();
});

function actualizarVisibilidadDecena() {
    if (checkboxPrimera.checked || checkboxSegunda.checked || checkboxTercera.checked) {
        decDivCantidad.style.display = "block";
    } else {
        cantidadADocena.value = "";
        decDivCantidad.style.display = "none";
    }
}

checkboxPrimera.addEventListener('click', () => {
    if (checkboxPrimera.checked) {
        checkboxSegunda.checked = false;
        checkboxTercera.checked = false;
    }
    if (!checkboxPrimera.checked && !checkboxSegunda.checked && !checkboxTercera.checked) {
        cantidadADocena.value = "";
    }
    actualizarVisibilidadDecena();
});

checkboxSegunda.addEventListener('click', () => {
    if (checkboxSegunda.checked) {
        checkboxPrimera.checked = false;
        checkboxTercera.checked = false;
    }
    if (!checkboxPrimera.checked && !checkboxSegunda.checked && !checkboxTercera.checked) {
        cantidadADocena.value = "";
    }
    actualizarVisibilidadDecena();
});

checkboxTercera.addEventListener('click', () => {
    if (checkboxTercera.checked) {
        checkboxPrimera.checked = false;
        checkboxSegunda.checked = false;
    }
    if (!checkboxPrimera.checked && !checkboxSegunda.checked && !checkboxTercera.checked) {
        cantidadADocena.value = "";
    }
    actualizarVisibilidadDecena();
});

btnSpin.addEventListener('click', async function () {
    if((checkboxRojo.checked || checkboxNegro.checked || checkboxVerde.checked || checkboxPar.checked || checkboxImpar.checked || checkboxPrimera.checked || checkboxSegunda.checked || checkboxTercera.checked) && (cantidadAColor.value !== '' || cantidadAParidad.value !== '' || cantidadADocena.value !== '')) {
        
        let currentBalance = parseFloat(document.querySelector('#tagBalance').innerHTML);
        let valueAColor = cantidadAColor.value === '' ? 0 : Number(cantidadAColor.value);
        let valueAParidad = cantidadAParidad.value === '' ? 0 : Number(cantidadAParidad.value);
        let valueADocena = cantidadADocena.value === '' ? 0 : Number(cantidadADocena.value);

        const values = [valueAColor, valueAParidad, valueADocena];
        if (values.some((x) => !Number.isInteger(x) || x < 0) || (valueAColor + valueAParidad + valueADocena) > 10000) {
            Swal.fire({
                icon: "error",
                title: "Cada apuesta debe ser un entero y la suma no puede pasar de 10000",
            });
            return;
        }
        else if ((valueAColor + valueAParidad + valueADocena) > currentBalance) {
            Swal.fire({
                icon: "error",
                title: "No puedes apostar más de balance",
            });
            return;
        }

        const bets = [];
        
        if (checkboxRojo.checked && valueAColor > 0) {
            bets.push({ type: 'color', value: 'Rojo', amount: valueAColor });
        } else if (checkboxNegro.checked && valueAColor > 0) {
            bets.push({ type: 'color', value: 'Negro', amount: valueAColor });
        } else if (checkboxVerde.checked && valueAColor > 0) {
            bets.push({ type: 'color', value: 'Verde', amount: valueAColor });
        }

        if (checkboxPar.checked && valueAParidad > 0) {
            bets.push({ type: 'parity', value: 'par', amount: valueAParidad });
        } else if (checkboxImpar.checked && valueAParidad > 0) {
            bets.push({ type: 'parity', value: 'impar', amount: valueAParidad });
        }

        if (checkboxPrimera.checked && valueADocena > 0) {
            bets.push({ type: 'dozen', value: '1', amount: valueADocena });
        } else if (checkboxSegunda.checked && valueADocena > 0) {
            bets.push({ type: 'dozen', value: '2', amount: valueADocena });
        } else if (checkboxTercera.checked && valueADocena > 0) {
            bets.push({ type: 'dozen', value: '3', amount: valueADocena });
        }

        btnSpin.disabled = true;

        try {
            const token = localStorage.getItem('token');

            const response = await fetch(getApiUrl(API_CONFIG.ENDPOINTS.PLAY_ROULETTE), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    bets: bets
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Error en el juego');
            }

            const result = await response.json();

            wheel.spinToItem(result.winningIndex, 6000, false, 2);

            setTimeout(() => {
                btnSpin.disabled = false;

                tagBalance.innerHTML = result.newBalance;

                if (result.totalAmountChange > 0) {
                    showHasWon();
                } else {
                    showHasLost();
                }


                cantidadAColor.value = '';
                cantidadAParidad.value = '';
                cantidadADocena.value = '';

                checkboxRojo.checked = false;
                checkboxNegro.checked = false;
                checkboxVerde.checked = false;
                checkboxPar.checked = false;
                checkboxImpar.checked = false;
                checkboxPrimera.checked = false;
                checkboxSegunda.checked = false;
                checkboxTercera.checked = false;

                actualizarVisibilidad();
                actualizarVisibilidadParidad();
                actualizarVisibilidadDecena();

            }, 6500);

        } catch (error) {
            btnSpin.disabled = false;
            Swal.fire({
                icon: "error",
                title: "Error",
                text: error.message
            });
        }

    } else {
        Swal.fire({
            icon: "error",
            title: "Salio algo mal",
            text: "Ingresa una cantidad y seleccion!",
        })
    }
});

init();