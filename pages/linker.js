import "babel-polyfill";
import React from 'react';
import Router from 'next/router';
import { eth } from 'decentraland-commons';
import { LANDRegistry } from 'decentraland-contracts';

async function ethereum() {
  const { address } = await getContractAddress()
  const land = new LANDRegistry(address)

  await eth.connect([land])

  return {
    address: await eth.getAddress(),
    land,
    web3: eth.web3
  }
}

async function getContractAddress() {
  const res = await fetch('/api/contract-address');
  return await res.json();
}

async function getSceneMetadata() {
  const res = await fetch('/api/get-scene-data');
  return await res.json();
}

async function getIpnsHash() {
  const res = await fetch('/api/get-ipns-hash');
  const ipnsHash = await res.json();
  return ipnsHash;
}

async function closeServer(ok) {
  const res = await fetch(`/api/close?ok=${ok}`);
}

export default class Page extends React.Component {
  constructor(...args) {
    super(...args);

    this.state = {
      loading: true,
      error: false,
      address: null,
      tx: null
    }
  }

  async componentDidMount() {
    try {
      const { land, address, web3 } = await ethereum()

      this.setState({
        loading: false,
        address
      })

      try {
        const sceneMetadata = await getSceneMetadata();
        this.setState({ sceneMetadata });
      } catch(err) {
        this.setState({
          error: `There was a problem getting scene data.\nTry to re-initialize the project with dcl init.`
        });
        return;
      }

      try {
        const ipnsHash = await getIpnsHash();
        this.setState({ ipnsHash });
      } catch(err) {
        this.setState({
          error: `There was a problem getting IPNS hash of your scene.\nTry to re-upload with dcl upload.`
        });
        return;
      }

      const coordinates = [];

      this.state.sceneMetadata.scene.parcels.forEach(parcel => {
        const [x, y] = parcel.split(",");

        coordinates.push({
          x: parseInt(x, 10),
          y: parseInt(y, 10)
        })
      });
      const data = `0,${this.state.ipnsHash}`
      const tx = await land.updateManyLandData(coordinates, data)
      this.setState({ tx })

      closeServer(true)
    } catch(err) {
      this.setState({loading: false, error: err.message})
      closeServer(false)
    }
  }

  renderTxHash = () => (
    this.state.tx ? (
      <p>Transaction:<br />
        <a href={`https://ropsten.etherscan.io/tx/${this.state.tx}`} target="_blank">
          {`https://ropsten.etherscan.io/tx/${this.state.tx}`}
        </a>
      </p>
     ) : null
  )

  renderError = () => (
    this.state.error ? <p>{this.state.error}</p> : null
  )

  render() {
    return (
      <div className="dcl-linker-main">
        <div className="dcl-icon"></div>
        <h3>UPDATE LAND DATA</h3>
        <p>MetaMask address:<br />
          {this.state.loading ? "loading..." : this.state.address}
        </p>
        {this.renderTxHash()}
        {this.renderError()}
        <style jsx>{`
          .dcl-icon {
            width: 52px;
            height: 52px;
            margin: 30px auto 0;
            background-image: url("https://decentraland.org/images/icons.svg");
          }
        `}</style>
        <style global jsx>{`
          body {
            font-family: "Arial";
            width: 700px;
            text-align: center;
            margin: 30px auto 0;
          }
          a {
            font-size: 12px;
            color: #00a55b;
          }
        `}</style>
      </div>
    )
  }
}
