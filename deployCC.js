/*eslint-env node*/

var express = require('express');
var util = require('util');
// cfenv provides access to your Cloud Foundry environment
// for more info, see: https://www.npmjs.com/package/cfenv
// var cfenv = require('cfenv');

//hyperledger SDK
var hfc = require('hfc');
//Access directories 
var fs = require('fs');
const https = require('https');

var USE_BLOCKVOTE_CC = true;
var DEV_MODE = false;
// Creating an environment variable for ciphersuites
process.env['GRPC_SSL_CIPHER_SUITES'] = 'ECDHE-RSA-AES128-GCM-SHA256:' +
    'ECDHE-RSA-AES128-SHA256:' +
    'ECDHE-RSA-AES256-SHA384:' +
    'ECDHE-RSA-AES256-GCM-SHA384:' +
    'ECDHE-ECDSA-AES128-GCM-SHA256:' +
    'ECDHE-ECDSA-AES128-SHA256:' +
    'ECDHE-ECDSA-AES256-SHA384:' +
    'ECDHE-ECDSA-AES256-GCM-SHA384';
//*******************************HFC SDK SETUP START ******************************

// Create a client blockchin.
var chain = hfc.newChain("BallotChain")

//Set the default chaincode path 
var ccPath = "";
if (USE_BLOCKVOTE_CC) {
    ccPath = process.env["GOPATH"] + "/src/BlockVoteChainCode/start";
} else {
    ccPath = process.env["GOPATH"] + "/src/chaincode_example02";
}


console.log("The chaincode is supposed to bet at:" + ccPath);

// Read and process the credentials.json
var network;
try {
    network = JSON.parse(fs.readFileSync(__dirname + '/ServiceCredentials.json', 'utf8'));
} catch (err) {
    console.log("ServiceCredentials.json is missing, Rerun once the file is available")
    process.exit();
}

var peers = network.credentials.peers;
var users = network.credentials.users;

//Download the certificates from Bluemix
var certFile = 'certificate.pem';
var certUrl = network.credentials.cert;
fs.access(certFile, function(err) {
    if (!err) {
        console.log("\nDeleting existing certificate ", certFile);
        fs.unlinkSync(certFile);
    }

    downloadCertificate();
});

function downloadCertificate() {
    var file = fs.createWriteStream(certFile);
    var data = '';
    https.get(certUrl, function(res) {
        console.log('\nDownloading %s from %s', certFile, certUrl);
        if (res.statusCode !== 200) {
            console.log('\nDownload certificate failed, error code = %d', certFile, res.statusCode);
            process.exit();
        }
        res.on('data', function(d) {
            data += d;
        });
        // event received when certificate download is completed
        res.on('end', function() {
            if (process.platform != "win32") {
                data += '\n';
            }
            fs.writeFileSync(certFile, data);
            copyCertificate();
        });
    }).on('error', function(e) {
        console.error(e);
        process.exit();
    });
}
//copy the certificate.pem over to the chaincode folder 
function copyCertificate() {
    //fs.createReadStream('certificate.pem').pipe(fs.createWriteStream(ccPath+'/certificate.pem'));
    fs.writeFileSync(ccPath + '/certificate.pem', fs.readFileSync(__dirname + '/certificate.pem'));

    setTimeout(function() {
        enrollAdmin();
    }, 1000);
}


var network_id = Object.keys(network.credentials.ca);
var uuid = network_id[0].substring(0, 8);

//keyValStore is local 
chain.setKeyValStore(hfc.newFileKeyValStore(__dirname + '/keyValStore-' + uuid));

var admin;

function enrollAdmin() {

    // Set the URL for membership services
    var ca_url = "grpcs://" + network.credentials.ca[network_id].discovery_host + ":" + network.credentials.ca[network_id].discovery_port;
    var cert = fs.readFileSync(certFile);
    chain.setMemberServicesUrl(ca_url, {
        pem: cert
    });

    // Adding all the peers to blockchain
    // this adds high availability for the client
    for (var i = 0; i < peers.length; i++) {
        chain.addPeer("grpcs://" + peers[i].discovery_host + ":" + peers[i].discovery_port, {
            pem: cert
        });
    }

    // console.log("\n\n------------- peers and caserver information: -------------");
    // console.log(chain.getPeers());
    // console.log(chain.getMemberServices());
    // console.log('-----------------------------------------------------------\n\n');

    if (DEV_MODE) {
        chain.setDevMode(true);
        console.log("The chain is set to development mode");
        //Deploy will not take long as the chain should already be running
        chain.setDeployWaitTime(10);
    } else {
        // chain.setDeployWaitTime(120);
    }

    //TODO: Register and enroll our own admin, instead of the hardcoded one in membersrvc.yaml! 
    // var SuperAdmin = new Member(registrationRequest, chain);
    // console.log(SuperAdmin);
    //enroll the admin 
    console.log("Enrolling admin");
    chain.enroll(users[0].username, users[0].secret, function(err, user) {
        if (err) throw Error("\nERROR: failed to enroll admin : %s", err);
        // Set this user as the chain's registrar which is authorized to register other users.
        /*
            Andrei: What can the registrar do? 
         */
        admin = user;
        chain.setRegistrar(admin);
        // console.log(admin)
        console.log("Admin is now enrolled.")

        //TODO: have some kind of delay here as registering a new user won't work if done right away?

        deploy();
    });
}





//admin deploys the chaincode
function deploy() {

    console.log("Deploying chaincode ...");
    // Construct the deploy request
    var deployRequest;
    if (USE_BLOCKVOTE_CC) {
        deployRequest = {
            // Function to trigger
            fcn: "init",
            // Arguments to the initializing function
            args: ["Brexit Vote"],
            certificatePath: "/certs/peer/cert.pem"

        }
        deployRequest.chaincodePath = "BlockVoteChainCode/start";
    } else {
        deployRequest = {
            // Function to trigger
            fcn: "init",
            // Arguments to the initializing function
            args: ["a", "100", "b", "200"],
            certificatePath: "/certs/peer/cert.pem"

        }
        deployRequest.chaincodePath = "chaincode_example02";
    }

    // Issue the deploy request and listen for events
    // This does not mean that the chaincode docker image has been created in the peer, check the peer logs for this 
    var tx = admin.deploy(deployRequest);
    tx.on('complete', function(results) {
        // Deploy request completed successfully
        console.log("deploy complete; results: %j", results);
        // Set the testChaincodeID for subsequent tests
        chaincodeID = results.chaincodeID;
        console.log("record this Chaincode ID: " + chaincodeID);
        // registerNewUser();

    });
    tx.on('error', function(error) {
        console.log("Failed to deploy chaincode: request=%j, error=%k", deployRequest, error);
        process.exit(1);
    });

}