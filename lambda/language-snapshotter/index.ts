export const handler = async (event:any)=>{
    console.log("Language Snapshotter Event ", JSON.stringify(event, null, 2));

    return{
        statusCode: 200,
        body: JSON.stringify({
            message: "Hello from Language Snapshotter!",
            input: event,
        })
    }
}